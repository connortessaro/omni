//! Modifier-only chords cannot be registered through the global shortcut plugin.
//! Query Quartz's session key state so this works even when Omni isn't focused.
//! A state query is not an event stream, so unlike a CGEventTap it needs neither
//! Accessibility nor Input Monitoring permission.
use super::{handle_shortcut_action, is_modifier_chord, RegisteredShortcuts, MODIFIER_CHORDS};
use tauri::{AppHandle, Manager, Runtime};
use tokio::time::{sleep, Duration};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
}

/// Every modifier the loop watches: the chord pairs, plus both Controls, which no
/// chord uses but which have to be up for one to fire.
const WATCHED: [u16; 8] = [0x37, 0x36, 0x38, 0x3C, 0x3A, 0x3D, 0x3B, 0x3E];

const POLL_ACTIVE: Duration = Duration::from_millis(24);
const POLL_IDLE: Duration = Duration::from_millis(250);

/// Both Shift keys and both Option keys are far easier to press by accident than
/// both Commands, so a chord has to survive several polls before it counts. At
/// POLL_ACTIVE this is roughly 120ms, which is imperceptible when you meant it.
const HOLD_POLLS: u8 = 5;

#[derive(Default)]
struct Chord {
    held: u8,
    latched: bool,
}

impl Chord {
    /// `both`/`any` describe this chord's own pair. `clean` means no other
    /// modifier is down.
    fn update(&mut self, both: bool, any: bool, clean: bool) -> bool {
        if !any {
            self.latched = false;
        }
        if !clean {
            // A foreign modifier means these keys belong to some other app's
            // shortcut. Wait for a full release before arming again.
            self.latched = true;
        }
        if !both || !clean {
            // Require both keys released before another capture, so a chord
            // cannot repeat when one key bounces while the other is held.
            self.held = 0;
            return false;
        }
        self.held = self.held.saturating_add(1);
        let fire = self.held >= HOLD_POLLS && !self.latched;
        self.latched |= fire;
        fire
    }

    /// Nothing is bound: if a chord is enabled while already held, wait for a
    /// release rather than firing on the next poll.
    fn disarm(&mut self) {
        self.held = 0;
        self.latched = true;
    }
}

fn key_down(key: u16) -> bool {
    // 0 = kCGEventSourceStateCombinedSessionState. This query neither consumes
    // nor synthesizes keyboard events.
    unsafe { CGEventSourceKeyState(0, key) }
}

/// Every enabled binding whose key is a chord, as (action_id, chord key).
fn bound_chords<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, String)> {
    let state = app.state::<RegisteredShortcuts>();
    let registered = state.shortcuts.lock().unwrap_or_else(|e| e.into_inner());
    registered
        .iter()
        .filter(|(_, key)| is_modifier_chord(key))
        .map(|(action, key)| (action.clone(), key.clone()))
        .collect()
}

/// The action handlers touch NSPanel and NSWindow, which AppKit only allows from
/// the main thread.
fn dispatch<R: Runtime>(app: &AppHandle<R>, action: &str) {
    let handle = app.clone();
    let action = action.to_string();
    if let Err(e) = app.run_on_main_thread(move || handle_shortcut_action(&handle, &action)) {
        eprintln!("Failed to dispatch chord action: {}", e);
    }
}

pub(super) fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut chords: Vec<Chord> = MODIFIER_CHORDS.iter().map(|_| Chord::default()).collect();

        loop {
            let bound = bound_chords(&app);
            if bound.is_empty() {
                for chord in chords.iter_mut() {
                    chord.disarm();
                }
                sleep(POLL_IDLE).await;
                continue;
            }

            let mut down = [0u16; WATCHED.len()];
            let mut count = 0;
            for code in WATCHED {
                if key_down(code) {
                    down[count] = code;
                    count += 1;
                }
            }
            let down = &down[..count];

            for (chord, (key, left, right)) in chords.iter_mut().zip(MODIFIER_CHORDS) {
                let both = down.contains(left) && down.contains(right);
                let any = down.contains(left) || down.contains(right);
                let clean = down.iter().all(|code| code == left || code == right);
                if !chord.update(both, any, clean) {
                    continue;
                }
                for (action, _) in bound.iter().filter(|(_, bound_key)| bound_key == key) {
                    dispatch(&app, action);
                }
            }

            sleep(POLL_ACTIVE).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors what the poll loop derives from the watched keycodes.
    fn poll(chord: &mut Chord, left: bool, right: bool, foreign: bool) -> bool {
        chord.update(left && right, left || right, !foreign)
    }

    /// Both keys down and nothing else, long enough to clear the threshold.
    fn hold(chord: &mut Chord) -> bool {
        let mut fired = false;
        for _ in 0..HOLD_POLLS {
            fired |= poll(chord, true, true, false);
        }
        fired
    }

    #[test]
    fn either_order_fires_once_until_both_keys_are_released() {
        for (left, right) in [(true, false), (false, true)] {
            let mut chord = Chord::default();
            assert!(!poll(&mut chord, false, false, false));
            assert!(!poll(&mut chord, left, right, false));
            assert!(hold(&mut chord));
            assert!(!hold(&mut chord));
            // One key bouncing while the other stays held must not re-fire.
            assert!(!poll(&mut chord, left, right, false));
            assert!(!hold(&mut chord));
            assert!(!poll(&mut chord, false, false, false));
            assert!(hold(&mut chord));
        }
    }

    #[test]
    fn a_tap_shorter_than_the_hold_threshold_does_not_fire() {
        let mut chord = Chord::default();
        for _ in 0..HOLD_POLLS - 1 {
            assert!(!poll(&mut chord, true, true, false));
        }
        assert!(!poll(&mut chord, false, false, false));
        assert!(!poll(&mut chord, true, true, false));
    }

    #[test]
    fn a_foreign_modifier_suppresses_the_chord_until_release() {
        let mut chord = Chord::default();
        for _ in 0..HOLD_POLLS * 2 {
            assert!(!poll(&mut chord, true, true, true));
        }
        // Releasing only the foreign modifier is not enough.
        assert!(!hold(&mut chord));
        assert!(!poll(&mut chord, false, false, false));
        assert!(hold(&mut chord));
    }

    #[test]
    fn enabling_while_held_requires_release() {
        let mut chord = Chord::default();
        chord.disarm();
        assert!(!hold(&mut chord));
        assert!(!poll(&mut chord, true, false, false));
        assert!(!poll(&mut chord, false, false, false));
        assert!(hold(&mut chord));
    }

    #[test]
    fn every_watched_keycode_is_distinct_and_covers_the_chord_table() {
        let mut seen = WATCHED.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), WATCHED.len(), "duplicate keycode in WATCHED");
        for (key, left, right) in MODIFIER_CHORDS {
            assert!(WATCHED.contains(left), "{key} left keycode is not watched");
            assert!(
                WATCHED.contains(right),
                "{key} right keycode is not watched"
            );
        }
    }
}
