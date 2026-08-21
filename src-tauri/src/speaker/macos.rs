// Omni macos speaker input and stream
//
// System audio is captured with ScreenCaptureKit: an SCStream configured for
// audio only, whose SCStreamOutput callback lands on a dispatch queue and
// pushes mono f32 samples into the same queue-and-waker shape windows.rs and
// linux.rs use.
//
// ScreenCaptureKit authorizes against Screen Recording, which the app already
// holds for screenshots, so this adds no second permission prompt. It also
// needs no Objective-C of its own: the objc2 bindings link the framework
// declaratively, which is what makes this buildable with Command Line Tools
// where the earlier `cidre` (CoreAudio process taps) attempt was not.
use super::AudioDevice;
use anyhow::{anyhow, Result};
use futures_util::Stream;
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::task::{Poll, Waker};
use std::thread;
use std::time::Duration;
use tracing::error;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_audio_types::AudioBufferList;
use objc2_core_media::CMSampleBuffer;
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
    SCStreamOutputType, SCWindow,
};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u32 = 2;

// ScreenCaptureKit taps the whole output mix and offers no per-device
// selection, so there is exactly one thing to capture. Reporting a list of
// output devices that all behaved identically would be a dropdown that does
// nothing.
const SYSTEM_MIX_ID: &str = "system-mix";

// Matching windows.rs and linux.rs, which cap at the same figure.
const MAX_BUFFER_SIZE: usize = 131072;

// Long enough to cover a permission prompt the user has to read.
const SHAREABLE_CONTENT_TIMEOUT: Duration = Duration::from_secs(30);
const START_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Asks ScreenCaptureKit what is capturable. Doubles as the authorization
/// probe: when Screen Recording has not been granted this is the call that
/// fails, and its message is what the user needs to see.
fn shareable_content() -> Result<Retained<SCShareableContent>> {
    let (tx, rx) = mpsc::channel();
    let handler =
        block2::RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
            let result = if content.is_null() {
                let detail = if err.is_null() {
                    "ScreenCaptureKit returned no content and no error".to_string()
                } else {
                    unsafe { (*err).localizedDescription() }.to_string()
                };
                Err(detail)
            } else {
                match unsafe { Retained::retain(content) } {
                    Some(retained) => Ok(SendPtr(retained)),
                    None => Err("ScreenCaptureKit content could not be retained".to_string()),
                }
            };
            let _ = tx.send(result);
        });

    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };

    match rx.recv_timeout(SHAREABLE_CONTENT_TIMEOUT) {
        Ok(Ok(content)) => Ok(content.0),
        Ok(Err(detail)) => Err(anyhow!(
            "system audio capture needs Screen Recording permission: {detail}"
        )),
        Err(_) => Err(anyhow!(
            "timed out waiting for ScreenCaptureKit to report capturable content"
        )),
    }
}

/// ScreenCaptureKit delivers its completion handler on its own queue, so the
/// retained result has to cross a channel back to the caller. The pointer is
/// only ever dereferenced on the receiving thread, and SCShareableContent is
/// not main-thread-bound.
struct SendPtr(Retained<SCShareableContent>);
unsafe impl Send for SendPtr {}

pub fn get_output_devices() -> Result<Vec<AudioDevice>> {
    // Fails when Screen Recording has not been granted, which is what the
    // settings page needs to be able to say.
    shareable_content()?;

    Ok(vec![AudioDevice {
        id: SYSTEM_MIX_ID.to_string(),
        name: "System audio (all output)".to_string(),
        is_default: true,
    }])
}

pub struct SpeakerInput;

impl SpeakerInput {
    /// `device_id` is accepted for parity with the other platforms and ignored:
    /// ScreenCaptureKit captures the output mix, and `get_output_devices`
    /// offers only that one entry.
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        // Verify authorization here rather than in the capture thread, so
        // `check_system_audio_access` gets a real answer and a denied
        // permission surfaces as an error instead of a silent dead stream.
        shareable_content()?;
        Ok(Self)
    }

    pub fn stream(self) -> SpeakerStream {
        let sample_queue = Arc::new(Mutex::new(VecDeque::new()));
        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
            shutdown: false,
        }));
        let shutdown = Arc::new((Mutex::new(false), Condvar::new()));
        let (init_tx, init_rx) = mpsc::channel();

        let queue_clone = sample_queue.clone();
        let waker_clone = waker_state.clone();
        let shutdown_clone = shutdown.clone();

        let capture_thread = thread::spawn(move || {
            if let Err(e) =
                SpeakerStream::capture_audio_loop(queue_clone, waker_clone, init_tx, shutdown_clone)
            {
                error!("Omni Audio capture loop failed: {}", e);
            }
        });

        let actual_sample_rate = match init_rx.recv_timeout(SHAREABLE_CONTENT_TIMEOUT) {
            Ok(Ok(rate)) => rate,
            Ok(Err(e)) => {
                error!("Omni Audio initialization failed: {}", e);
                SAMPLE_RATE
            }
            Err(_) => {
                error!("Omni Audio initialization timeout");
                SAMPLE_RATE
            }
        };

        SpeakerStream {
            sample_queue,
            waker_state,
            shutdown,
            capture_thread: Some(capture_thread),
            actual_sample_rate,
        }
    }
}

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
    shutdown: bool,
}

/// Shared with the ScreenCaptureKit callback, which runs on a dispatch queue.
struct TapIvars {
    sample_queue: Arc<Mutex<VecDeque<f32>>>,
    waker_state: Arc<Mutex<WakerState>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "OmniSystemAudioTap"]
    #[ivars = TapIvars]
    struct AudioTap;

    unsafe impl NSObjectProtocol for AudioTap {}

    unsafe impl SCStreamOutput for AudioTap {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn did_output_sample_buffer(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            if output_type != SCStreamOutputType::Audio {
                return;
            }

            let samples = match unsafe { mono_samples(sample_buffer) } {
                Ok(samples) => samples,
                Err(e) => {
                    error!("Omni Audio sample extraction failed: {}", e);
                    return;
                }
            };
            if samples.is_empty() {
                return;
            }

            let dropped = {
                let mut queue = self.ivars().sample_queue.lock().unwrap();
                queue.extend(samples.iter());

                if queue.len() > MAX_BUFFER_SIZE {
                    let to_drop = queue.len() - MAX_BUFFER_SIZE;
                    queue.drain(0..to_drop);
                    to_drop
                } else {
                    0
                }
            };

            if dropped > 0 {
                error!("macOS buffer overflow - dropped {} samples", dropped);
            }

            let mut state = self.ivars().waker_state.lock().unwrap();
            if !state.has_data {
                state.has_data = true;
                if let Some(waker) = state.waker.take() {
                    drop(state);
                    waker.wake();
                }
            }
        }
    }
);

/// Pulls one sample buffer out as mono f32.
///
/// ScreenCaptureKit hands over non-interleaved float32, one plane per channel,
/// so the channels are averaged rather than read end to end.
unsafe fn mono_samples(sample_buffer: &CMSampleBuffer) -> Result<Vec<f32>> {
    // Two passes, because this call wants `buffer_list_size` to be *exactly*
    // the size needed. Passing anything larger also fails with
    // kCMSampleBufferError_ArrayTooSmall (-12737), so the size has to be asked
    // for rather than over-provisioned.
    let mut needed: usize = 0;
    let status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            &mut needed,
            std::ptr::null_mut(),
            0,
            None,
            None,
            0,
            std::ptr::null_mut(),
        )
    };
    if needed == 0 {
        return Err(anyhow!(
            "could not size the audio buffer list (status {status})"
        ));
    }

    let mut raw = vec![0u8; needed];
    let mut block_buffer: *mut objc2_core_media::CMBlockBuffer = std::ptr::null_mut();
    let status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            &mut needed,
            raw.as_mut_ptr() as *mut AudioBufferList,
            needed,
            None,
            None,
            0,
            &mut block_buffer,
        )
    };
    if status != 0 {
        return Err(anyhow!("audio buffer list unavailable (status {status})"));
    }

    // Released when this drops; the call above retained it.
    let _block_buffer = std::ptr::NonNull::new(block_buffer)
        .map(|ptr| unsafe { objc2_core_foundation::CFRetained::from_raw(ptr) });

    let list = unsafe { &*(raw.as_ptr() as *const AudioBufferList) };
    let buffers =
        unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize) };

    let planes: Vec<&[f32]> = buffers
        .iter()
        .filter(|buffer| !buffer.mData.is_null())
        .map(|buffer| unsafe {
            std::slice::from_raw_parts(
                buffer.mData as *const f32,
                buffer.mDataByteSize as usize / std::mem::size_of::<f32>(),
            )
        })
        .collect();

    Ok(downmix_to_mono(&planes))
}

/// Averages one plane per channel down to a single channel.
///
/// Shortest plane wins: a truncated trailing plane would otherwise be read past
/// its end. Summing without dividing is the tempting version and it clips, so
/// the scale stays.
fn downmix_to_mono(planes: &[&[f32]]) -> Vec<f32> {
    let Some(frames) = planes.iter().map(|plane| plane.len()).min() else {
        return Vec::new();
    };

    let scale = 1.0 / planes.len() as f32;
    (0..frames)
        .map(|i| planes.iter().map(|plane| plane[i]).sum::<f32>() * scale)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_planes_average_into_one_channel() {
        let left = [1.0f32, 0.5, -1.0];
        let right = [0.0f32, 0.5, 1.0];

        assert_eq!(
            downmix_to_mono(&[&left, &right]),
            vec![0.5, 0.5, 0.0],
            "channels are averaged, not summed"
        );
    }

    #[test]
    fn a_full_scale_stereo_signal_stays_in_range() {
        // Summing instead of averaging would give 2.0 here and clip the WAV.
        let left = [1.0f32; 4];
        let right = [1.0f32; 4];

        for sample in downmix_to_mono(&[&left, &right]) {
            assert!(sample <= 1.0, "sample {sample} exceeded full scale");
        }
    }

    #[test]
    fn mono_input_passes_through_unchanged() {
        let only = [0.25f32, -0.75, 0.5];
        assert_eq!(downmix_to_mono(&[&only]), only.to_vec());
    }

    #[test]
    fn a_short_plane_bounds_the_output() {
        // ScreenCaptureKit is expected to deliver equal-length planes, but
        // indexing past a short one would read out of bounds.
        let left = [1.0f32, 1.0, 1.0];
        let right = [1.0f32];

        assert_eq!(downmix_to_mono(&[&left, &right]).len(), 1);
    }

    #[test]
    fn no_planes_yields_no_samples() {
        assert!(downmix_to_mono(&[]).is_empty());
    }

    /// Captures the live system mix through the same API the app uses.
    ///
    /// Ignored by default because it needs Screen Recording granted to whatever
    /// process runs the test, so it cannot pass in CI. Run it by hand, with
    /// audio playing, to check the whole path rather than the arithmetic:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     -- --ignored --nocapture captures_the_live_system_mix
    /// ```
    #[test]
    #[ignore = "needs Screen Recording authorization and real playback"]
    fn captures_the_live_system_mix() {
        use futures_util::StreamExt;

        let wanted = SAMPLE_RATE as usize; // one second
        let input = SpeakerInput::new(None).expect("system audio should be authorized");
        let mut stream = input.stream();
        assert_eq!(stream.sample_rate(), SAMPLE_RATE);

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let samples: Vec<f32> = runtime.block_on(async {
            let collect = async {
                let mut collected = Vec::with_capacity(wanted);
                while collected.len() < wanted {
                    match stream.next().await {
                        Some(sample) => collected.push(sample),
                        None => break,
                    }
                }
                collected
            };
            tokio::time::timeout(Duration::from_secs(20), collect)
                .await
                .expect("capture stalled")
        });

        assert_eq!(
            samples.len(),
            wanted,
            "the stream ended before delivering a second of audio"
        );

        let peak = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        let rms =
            (samples.iter().map(|s| (s * s) as f64).sum::<f64>() / samples.len() as f64).sqrt();
        println!(
            "captured {} samples, peak {peak:.6}, rms {rms:.6}",
            samples.len()
        );
        assert!(
            peak > 0.0,
            "every sample was silent: play audio while running this test"
        );
    }
}

pub struct SpeakerStream {
    sample_queue: Arc<Mutex<VecDeque<f32>>>,
    waker_state: Arc<Mutex<WakerState>>,
    shutdown: Arc<(Mutex<bool>, Condvar)>,
    capture_thread: Option<thread::JoinHandle<()>>,
    actual_sample_rate: u32,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.actual_sample_rate
    }

    fn capture_audio_loop(
        sample_queue: Arc<Mutex<VecDeque<f32>>>,
        waker_state: Arc<Mutex<WakerState>>,
        init_tx: mpsc::Sender<Result<u32>>,
        shutdown: Arc<(Mutex<bool>, Condvar)>,
    ) -> Result<()> {
        let setup = (|| -> Result<(Retained<SCStream>, Retained<AudioTap>)> {
            let content = shareable_content()?;
            let displays = unsafe { content.displays() };
            let display = displays
                .firstObject()
                .ok_or_else(|| anyhow!("no display available to attach system audio capture to"))?;

            // ScreenCaptureKit requires a content filter even for audio-only
            // capture; the display is what scopes the audio to this machine's
            // output.
            let excluded: Retained<NSArray<SCWindow>> = NSArray::new();
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &excluded,
                )
            };

            let config = unsafe { SCStreamConfiguration::new() };
            unsafe {
                config.setCapturesAudio(true);
                config.setSampleRate(SAMPLE_RATE as isize);
                config.setChannelCount(CHANNELS as isize);
                // Otherwise Omni captures its own playback and feeds it back in.
                config.setExcludesCurrentProcessAudio(true);
                // No screen output is attached, so keep the video side minimal.
                config.setWidth(2);
                config.setHeight(2);
            }

            let tap = {
                let this = AudioTap::alloc().set_ivars(TapIvars {
                    sample_queue: sample_queue.clone(),
                    waker_state: waker_state.clone(),
                });
                let tap: Retained<AudioTap> = unsafe { msg_send![super(this), init] };
                tap
            };

            let stream = unsafe {
                SCStream::initWithFilter_configuration_delegate(
                    SCStream::alloc(),
                    &filter,
                    &config,
                    None,
                )
            };

            let queue = dispatch2::DispatchQueue::new("com.omni.system-audio", None);
            unsafe {
                stream.addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*tap),
                    SCStreamOutputType::Audio,
                    Some(&queue),
                )
            }
            .map_err(|e| {
                anyhow!(
                    "could not attach the audio output: {}",
                    e.localizedDescription()
                )
            })?;

            let (start_tx, start_rx) = mpsc::channel();
            let start_handler = block2::RcBlock::new(move |err: *mut NSError| {
                let _ = start_tx.send(if err.is_null() {
                    Ok(())
                } else {
                    Err(unsafe { (*err).localizedDescription() }.to_string())
                });
            });
            unsafe { stream.startCaptureWithCompletionHandler(Some(&start_handler)) };

            match start_rx.recv_timeout(START_CAPTURE_TIMEOUT) {
                Ok(Ok(())) => {}
                Ok(Err(detail)) => {
                    return Err(anyhow!("could not start system audio capture: {detail}"))
                }
                Err(_) => {
                    return Err(anyhow!("timed out starting system audio capture"));
                }
            }

            Ok((stream, tap))
        })();

        let (stream, tap) = match setup {
            Ok(pair) => {
                let _ = init_tx.send(Ok(SAMPLE_RATE));
                pair
            }
            Err(e) => {
                // Unblock any consumer already polling: without this the
                // stream would sit Pending forever on a capture that never
                // started.
                let mut state = waker_state.lock().unwrap();
                state.shutdown = true;
                if let Some(waker) = state.waker.take() {
                    drop(state);
                    waker.wake();
                }
                let _ = init_tx.send(Err(e));
                return Ok(());
            }
        };

        // Samples arrive on the dispatch queue, so this thread only has to keep
        // the stream alive until shutdown.
        {
            let (lock, cvar) = &*shutdown;
            let mut stopping = lock.lock().unwrap();
            while !*stopping {
                stopping = cvar.wait(stopping).unwrap();
            }
        }

        let (stop_tx, stop_rx) = mpsc::channel();
        let stop_handler = block2::RcBlock::new(move |err: *mut NSError| {
            let _ = stop_tx.send(if err.is_null() {
                Ok(())
            } else {
                Err(unsafe { (*err).localizedDescription() }.to_string())
            });
        });
        unsafe { stream.stopCaptureWithCompletionHandler(Some(&stop_handler)) };

        match stop_rx.recv_timeout(START_CAPTURE_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(detail)) => error!("Omni Audio stop failed: {}", detail),
            Err(_) => error!("Omni Audio stop timed out"),
        }

        let _ = unsafe {
            stream.removeStreamOutput_type_error(
                ProtocolObject::from_ref(&*tap),
                SCStreamOutputType::Audio,
            )
        };

        Ok(())
    }
}

// Drops the audio stream
impl Drop for SpeakerStream {
    fn drop(&mut self) {
        {
            let mut state = self.waker_state.lock().unwrap();
            state.shutdown = true;
        }

        {
            let (lock, cvar) = &*self.shutdown;
            let mut stopping = lock.lock().unwrap();
            *stopping = true;
            cvar.notify_all();
        }

        if let Some(thread) = self.capture_thread.take() {
            if let Err(e) = thread.join() {
                error!("Failed to join capture thread: {:?}", e);
            }
        }
    }
}

// Stream of f32 audio samples from the speaker
impl Stream for SpeakerStream {
    type Item = f32;

    // Polls the audio stream
    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        {
            let mut queue = self.sample_queue.lock().unwrap();
            if let Some(sample) = queue.pop_front() {
                return Poll::Ready(Some(sample));
            }
        }

        {
            let mut state = self.waker_state.lock().unwrap();
            if state.shutdown {
                return Poll::Ready(None);
            }
            state.has_data = false;
            state.waker = Some(cx.waker().clone());
        }

        // Re-check after registering, so a sample that landed in between does
        // not sit in the queue waiting for the next callback to wake us.
        let mut queue = self.sample_queue.lock().unwrap();
        match queue.pop_front() {
            Some(sample) => Poll::Ready(Some(sample)),
            None => Poll::Pending,
        }
    }
}
