use std::sync::atomic::{AtomicBool, Ordering};
use once_cell::sync::Lazy;

static TYPING_ACTIVE: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static CANCEL_TYPING: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

#[tauri::command]
pub async fn cancel_human_typing() -> Result<(), String> {
    CANCEL_TYPING.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn is_human_typing() -> Result<bool, String> {
    Ok(TYPING_ACTIVE.load(Ordering::SeqCst))
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn simulate_human_typing(text: String, speed_wpm: Option<u32>) -> Result<(), String> {
    if TYPING_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("Typing simulation is already in progress".to_string());
    }
    CANCEL_TYPING.store(false, Ordering::SeqCst);

    let result = tokio::task::spawn_blocking(move || {
        macos::run_typing(text, speed_wpm.unwrap_or(100))
    })
    .await
    .map_err(|e| e.to_string())?;

    TYPING_ACTIVE.store(false, Ordering::SeqCst);
    result
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn simulate_human_typing(_text: String, _speed_wpm: Option<u32>) -> Result<(), String> {
    Err("Human typing simulation is currently supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::time::Duration;
    use std::thread::sleep;

    type CGEventRef = *mut std::ffi::c_void;
    type CGEventSourceRef = *mut std::ffi::c_void;
    type UniChar = u16;

    const K_CG_HID_EVENT_TAP: u32 = 0;

    extern "C" {
        fn CGEventCreateKeyboardEvent(
            source: CGEventSourceRef,
            virtual_key: u16,
            key_down: bool,
        ) -> CGEventRef;

        fn CGEventKeyboardSetUnicodeString(
            event: CGEventRef,
            string_length: u32,
            unicode_string: *const UniChar,
        );

        fn CGEventPost(tap: u32, event: CGEventRef);
        fn CFRelease(cf: *mut std::ffi::c_void);
    }

    pub fn run_typing(text: String, wpm: u32) -> Result<(), String> {
        // Base delay calculation:
        // Standard assumption: 1 word = 5 chars.
        // 100 WPM = 500 chars/min = 8.33 chars/sec = ~120ms per char.
        let target_wpm = wpm.clamp(30, 250);
        let base_delay_ms = (60_000.0 / (target_wpm as f64 * 5.0)) as u64;

        // Small initial pause to ensure target editor has key focus
        sleep(Duration::from_millis(200));

        let chars: Vec<char> = text.chars().collect();
        let mut pseudo_rng: u64 = 123456789;

        for (idx, &ch) in chars.iter().enumerate() {
            if CANCEL_TYPING.load(Ordering::SeqCst) {
                break;
            }

            // Simple fast pseudo-random generator for natural human jitter
            pseudo_rng = pseudo_rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let jitter_factor = ((pseudo_rng % 60) as i64) - 30; // -30ms to +30ms jitter
            let mut char_delay = (base_delay_ms as i64 + jitter_factor).max(35) as u64;

            // Natural human pacing adjustments
            if ch == '\n' {
                char_delay += 180; // Pause after entering a newline
            } else if ch == ';' || ch == '{' || ch == '}' || ch == ':' {
                char_delay += 80; // Thought pause at structural syntax
            } else if ch == ' ' {
                char_delay += 30; // Slight pause between words
            }

            // Post key down and key up events with Unicode character
            let mut utf16_buf = [0u16; 2];
            let encoded = ch.encode_utf16(&mut utf16_buf);

            unsafe {
                // Key Down
                let event_down = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, true);
                if !event_down.is_null() {
                    CGEventKeyboardSetUnicodeString(event_down, encoded.len() as u32, encoded.as_ptr());
                    CGEventPost(K_CG_HID_EVENT_TAP, event_down);
                    CFRelease(event_down);
                }

                // Dwell time: key is pressed down for 10-25ms before releasing
                let dwell_time = (15 + (pseudo_rng % 15)) as u64;
                sleep(Duration::from_millis(dwell_time));

                // Key Up
                let event_up = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, false);
                if !event_up.is_null() {
                    CGEventKeyboardSetUnicodeString(event_up, encoded.len() as u32, encoded.as_ptr());
                    CGEventPost(K_CG_HID_EVENT_TAP, event_up);
                    CFRelease(event_up);
                }
            }

            sleep(Duration::from_millis(char_delay));

            // Occasional micro-pause every 40-70 characters (simulating reading ahead)
            if idx > 0 && idx % 50 == 0 {
                sleep(Duration::from_millis(250 + ((pseudo_rng % 200) as u64)));
            }
        }

        Ok(())
    }
}
