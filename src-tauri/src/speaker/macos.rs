// Omni macos speaker input and stream
//
// System audio is captured with a CoreAudio process tap
// (`AudioHardwareCreateProcessTap`, macOS 14.2+): a global tap over the output
// mix feeds a private aggregate device, whose IOProc lands on a dispatch queue
// and pushes mono f32 samples into the same queue-and-waker shape windows.rs
// and linux.rs use.
//
// This replaced a working ScreenCaptureKit implementation for one reason. SCK
// authorizes against Screen Recording, and while an SCStream is live macOS adds
// a menu-bar item that reads "Screen Recording and System Audio Recording are
// in use" (measured by reading Control Center's accessibility tree, which,
// unlike a screenshot, does not itself count as screen capture). A process tap
// adds nothing to the menu bar while capturing. For an assistant that overlays
// other apps as a content-protected panel, announcing itself in the menu bar
// defeats the point.
//
// A tap is also a better fit mechanically: it delivers the mix already mono at
// the device's own sample rate, so there is no downmix and no resample, and it
// needs no Screen Recording grant.
//
// Like the SCK version, this compiles with Command Line Tools only. The
// `objc2-*` bindings link frameworks declaratively and compile no
// Objective-C, which is what the earlier `cidre` attempt could not do.
use super::AudioDevice;
use anyhow::{anyhow, Result};
use futures_util::Stream;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::task::{Poll, Waker};
use std::thread;
use std::time::Duration;
use tracing::{error, warn};

use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey,
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey,
    kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioSubTapDriftCompensationKey,
    kAudioSubTapUIDKey, kAudioTapPropertyFormat, AudioDeviceCreateIOProcIDWithBlock,
    AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop,
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription,
};
use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSObject, NSString};

/// Only used when the tap will not report its own format, which should not
/// happen; the real rate comes from `kAudioTapPropertyFormat`.
const FALLBACK_SAMPLE_RATE: u32 = 48_000;

/// A process tap captures the whole output mix and offers no per-device
/// selection, so there is exactly one thing to capture. Listing several output
/// devices that all behaved identically would be a dropdown that does nothing.
const SYSTEM_MIX_ID: &str = "system-mix";

/// Matching windows.rs and linux.rs, which cap at the same figure.
const MAX_BUFFER_SIZE: usize = 131072;

const AGGREGATE_UID: &str = "com.connortessaro.omni.system-audio";

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

/// CoreAudio's aggregate-device keys are plain C string literals rather than
/// CFStrings, so they need bridging into NSString to build the description.
fn key(name: &std::ffi::CStr) -> Retained<NSString> {
    NSString::from_str(name.to_str().expect("CoreAudio keys are ASCII"))
}

fn address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// Resolves this process to the audio object CoreAudio knows it by, so the tap
/// can leave Omni's own output out of the mix. Best effort: if it fails the tap
/// still works, it just also hears anything Omni plays.
fn own_audio_object() -> Option<AudioObjectID> {
    let pid: i32 = std::process::id() as i32;
    let mut object: AudioObjectID = 0;
    let addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject);
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;

    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            std::ptr::NonNull::from(&addr),
            std::mem::size_of::<i32>() as u32,
            &pid as *const i32 as *const c_void,
            std::ptr::NonNull::from(&mut size),
            std::ptr::NonNull::new(&mut object as *mut AudioObjectID as *mut c_void).unwrap(),
        )
    };

    if status == 0 && object != 0 {
        Some(object)
    } else {
        warn!("could not resolve Omni's own audio process object (status {status}); system audio capture will include Omni's own output");
        None
    }
}

/// The tap's own stream format. Its sample rate follows the current output
/// device, so it must be read rather than assumed.
fn tap_sample_rate(tap: AudioObjectID) -> u32 {
    let addr = address(kAudioTapPropertyFormat);
    let mut asbd: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;

    let status = unsafe {
        AudioObjectGetPropertyData(
            tap,
            std::ptr::NonNull::from(&addr),
            0,
            std::ptr::null(),
            std::ptr::NonNull::from(&mut size),
            std::ptr::NonNull::new(&mut asbd as *mut AudioStreamBasicDescription as *mut c_void)
                .unwrap(),
        )
    };

    let rate = asbd.mSampleRate as u32;
    if status != 0 || !(8000..=96000).contains(&rate) {
        warn!("tap reported an unusable sample rate (status {status}, rate {rate}); falling back to {FALLBACK_SAMPLE_RATE}");
        return FALLBACK_SAMPLE_RATE;
    }
    rate
}

/// A tap plus the private aggregate device that reads it. Both are torn down on
/// drop, in order, so a failed setup cannot leak a device into the user's audio
/// configuration.
struct Tap {
    tap_id: AudioObjectID,
    aggregate_id: AudioObjectID,
    sample_rate: u32,
}

impl Tap {
    fn new() -> Result<Self> {
        let excluded: Retained<NSArray<NSNumber>> = match own_audio_object() {
            Some(object) => NSArray::from_retained_slice(&[NSNumber::new_u32(object)]),
            None => NSArray::new(),
        };

        // Mono, because the pipeline downstream is single channel and the tap
        // will mix it for us rather than us averaging planes afterwards.
        let description = unsafe {
            CATapDescription::initMonoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &excluded,
            )
        };
        unsafe {
            description.setName(&ns("Omni system audio"));
            // Keeps the tap out of the system's audio device list.
            description.setPrivate(true);
        }

        let mut tap_id: AudioObjectID = 0;
        let status = unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap_id) };
        if status != 0 || tap_id == 0 {
            return Err(anyhow!(
                "could not create the system audio tap (status {status}). System audio capture needs macOS 14.2 or later."
            ));
        }

        let sample_rate = tap_sample_rate(tap_id);

        // The sub-tap is addressed by the description's UUID.
        let uid = unsafe { description.UUID().UUIDString() };
        let sub_tap: Retained<NSDictionary<NSString, NSObject>> = NSDictionary::from_slices(
            &[
                &*key(kAudioSubTapUIDKey),
                &*key(kAudioSubTapDriftCompensationKey),
            ],
            &[
                &*Retained::into_super(uid),
                &*Retained::into_super(Retained::into_super(NSNumber::new_bool(true))),
            ],
        );
        let tap_list: Retained<NSArray<NSDictionary<NSString, NSObject>>> =
            NSArray::from_slice(&[&*sub_tap]);

        let aggregate_description = NSDictionary::from_slices(
            &[
                &*key(kAudioAggregateDeviceNameKey),
                &*key(kAudioAggregateDeviceUIDKey),
                &*key(kAudioAggregateDeviceIsPrivateKey),
                &*key(kAudioAggregateDeviceIsStackedKey),
                &*key(kAudioAggregateDeviceTapListKey),
            ],
            &[
                &*Retained::into_super(ns("Omni System Audio")),
                &*Retained::into_super(ns(AGGREGATE_UID)),
                // Private, so it never shows up as a selectable output device.
                &*Retained::into_super(Retained::into_super(NSNumber::new_bool(true))),
                &*Retained::into_super(Retained::into_super(NSNumber::new_bool(false))),
                &*Retained::into_super(tap_list),
            ],
        );

        // NSDictionary and CFDictionary are toll-free bridged.
        let cf_description = unsafe {
            &*(Retained::as_ptr(&aggregate_description)
                as *const objc2_core_foundation::CFDictionary)
        };

        let mut aggregate_id: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(
                cf_description,
                std::ptr::NonNull::from(&mut aggregate_id),
            )
        };
        if status != 0 || aggregate_id == 0 {
            unsafe { AudioHardwareDestroyProcessTap(tap_id) };
            return Err(anyhow!(
                "could not create the aggregate device for the system audio tap (status {status})"
            ));
        }

        Ok(Self {
            tap_id,
            aggregate_id,
            sample_rate,
        })
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        // Aggregate first: it holds the tap.
        let status = unsafe { AudioHardwareDestroyAggregateDevice(self.aggregate_id) };
        if status != 0 {
            error!("failed to destroy the system audio aggregate device (status {status})");
        }
        let status = unsafe { AudioHardwareDestroyProcessTap(self.tap_id) };
        if status != 0 {
            error!("failed to destroy the system audio tap (status {status})");
        }
    }
}

pub fn get_output_devices() -> Result<Vec<AudioDevice>> {
    // Creating and immediately dropping a tap is the honest availability check:
    // it fails on macOS below 14.2 and if the platform refuses the tap, which
    // is what the settings page needs to be able to say.
    let tap = Tap::new()?;
    let rate = tap.sample_rate;
    drop(tap);

    Ok(vec![AudioDevice {
        id: SYSTEM_MIX_ID.to_string(),
        name: format!("System audio (all output, {} kHz)", rate / 1000),
        is_default: true,
    }])
}

pub struct SpeakerInput;

impl SpeakerInput {
    /// `device_id` is accepted for parity with the other platforms and ignored:
    /// a global tap captures the output mix, and `get_output_devices` offers
    /// only that one entry.
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        // Verify here rather than in the capture thread, so
        // `check_system_audio_access` gets a real answer and an unsupported
        // platform surfaces as an error instead of a silent dead stream.
        drop(Tap::new()?);
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

        let actual_sample_rate = match init_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(rate)) => rate,
            Ok(Err(e)) => {
                error!("Omni Audio initialization failed: {}", e);
                FALLBACK_SAMPLE_RATE
            }
            Err(_) => {
                error!("Omni Audio initialization timeout");
                FALLBACK_SAMPLE_RATE
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
        let tap = match Tap::new() {
            Ok(tap) => tap,
            Err(e) => {
                // Unblock any consumer already polling: without this the stream
                // would sit Pending forever on a capture that never started.
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

        let queue_for_block = sample_queue.clone();
        let waker_for_block = waker_state.clone();
        let io_block = block2::RcBlock::new(
            move |_now: std::ptr::NonNull<AudioTimeStamp>,
                  input: std::ptr::NonNull<AudioBufferList>,
                  _input_time: std::ptr::NonNull<AudioTimeStamp>,
                  _output: std::ptr::NonNull<AudioBufferList>,
                  _output_time: std::ptr::NonNull<AudioTimeStamp>| {
                let list = unsafe { input.as_ref() };
                let buffer_count = list.mNumberBuffers as usize;
                if buffer_count == 0 {
                    return;
                }

                let buffers =
                    unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), buffer_count) };
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

                // The tap is configured mono, so this is normally a copy. It
                // stays here so a stereo tap could not read past a short plane.
                let samples = downmix_to_mono(&planes);
                if samples.is_empty() {
                    return;
                }

                let dropped = {
                    let mut queue = queue_for_block.lock().unwrap();
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

                let mut state = waker_for_block.lock().unwrap();
                if !state.has_data {
                    state.has_data = true;
                    if let Some(waker) = state.waker.take() {
                        drop(state);
                        waker.wake();
                    }
                }
            },
        );

        let dispatch_queue =
            dispatch2::DispatchQueue::new("com.connortessaro.omni.system-audio", None);
        let mut proc_id: AudioDeviceIOProcID = None;
        let status = unsafe {
            AudioDeviceCreateIOProcIDWithBlock(
                std::ptr::NonNull::from(&mut proc_id),
                tap.aggregate_id,
                Some(&dispatch_queue),
                &*io_block as *const _ as *mut _,
            )
        };
        if status != 0 {
            let _ = init_tx.send(Err(anyhow!(
                "could not attach to the system audio tap (status {status})"
            )));
            return Ok(());
        }

        let status = unsafe { AudioDeviceStart(tap.aggregate_id, proc_id) };
        if status != 0 {
            unsafe { AudioDeviceDestroyIOProcID(tap.aggregate_id, proc_id) };
            let _ = init_tx.send(Err(anyhow!(
                "could not start the system audio tap (status {status})"
            )));
            return Ok(());
        }

        let _ = init_tx.send(Ok(tap.sample_rate));

        // Samples arrive on the dispatch queue, so this thread only has to keep
        // the tap alive until shutdown.
        {
            let (lock, cvar) = &*shutdown;
            let mut stopping = lock.lock().unwrap();
            while !*stopping {
                stopping = cvar.wait(stopping).unwrap();
            }
        }

        let status = unsafe { AudioDeviceStop(tap.aggregate_id, proc_id) };
        if status != 0 {
            error!("failed to stop the system audio tap (status {status})");
        }
        let status = unsafe { AudioDeviceDestroyIOProcID(tap.aggregate_id, proc_id) };
        if status != 0 {
            error!("failed to release the system audio IOProc (status {status})");
        }
        // `tap` drops here, tearing down the aggregate device and the tap.

        Ok(())
    }
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

    if planes.len() == 1 {
        return planes[0].to_vec();
    }

    let scale = 1.0 / planes.len() as f32;
    (0..frames)
        .map(|i| planes.iter().map(|plane| plane[i]).sum::<f32>() * scale)
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mono_plane_passes_through_unchanged() {
        let only = [0.25f32, -0.75, 0.5];
        assert_eq!(downmix_to_mono(&[&only]), only.to_vec());
    }

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
    fn a_short_plane_bounds_the_output() {
        // The tap is configured mono, but indexing past a short plane would
        // read out of bounds if that ever changed.
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
    /// Ignored by default because it needs real playback, so it cannot pass in
    /// CI. Run it by hand, with audio playing, to check the whole path rather
    /// than the arithmetic:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     -- --ignored --nocapture captures_the_live_system_mix
    /// ```
    #[test]
    #[ignore = "needs real playback through the default output device"]
    fn captures_the_live_system_mix() {
        use futures_util::StreamExt;

        let input = SpeakerInput::new(None).expect("system audio tap should be available");
        let mut stream = input.stream();
        let rate = stream.sample_rate();
        assert!(
            (8000..=96000).contains(&rate),
            "implausible sample rate {rate}"
        );

        let wanted = rate as usize; // one second
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
            "captured {} samples at {rate} Hz, peak {peak:.6}, rms {rms:.6}",
            samples.len()
        );
        assert!(
            peak > 0.0,
            "every sample was silent: play audio while running this test"
        );
    }
}
