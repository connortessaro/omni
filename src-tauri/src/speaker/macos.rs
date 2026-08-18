// Omni macos speaker input and stream
//
// System-audio capture is disabled in this build. The real implementation used
// `cidre` (CoreAudio process taps), whose build script requires a full Xcode
// install. This stub keeps the same API so `speaker::mod` and the Tauri
// commands compile with Command Line Tools only; every entry point reports the
// feature as unavailable rather than failing silently.
use super::AudioDevice;
use anyhow::{anyhow, Result};
use futures_util::Stream;
use std::task::Poll;

const UNAVAILABLE: &str = "system audio capture is not available in this build";

pub fn get_input_devices() -> Result<Vec<AudioDevice>> {
    Ok(Vec::new())
}

pub fn get_output_devices() -> Result<Vec<AudioDevice>> {
    Ok(Vec::new())
}

pub struct SpeakerInput;

impl SpeakerInput {
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        Err(anyhow!(UNAVAILABLE))
    }

    pub fn stream(self) -> SpeakerStream {
        unreachable!("SpeakerInput cannot be constructed: {UNAVAILABLE}")
    }
}

pub struct SpeakerStream;

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        0
    }
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        Poll::Ready(None)
    }
}
