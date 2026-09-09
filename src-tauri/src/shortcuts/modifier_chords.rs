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

/// No chord uses Control, but it has to be up for one to fire.
/// kVK_Control 0x3B, kVK_RightControl 0x3E.
const CONTROL_KEYS: [u16; 2] = [0x3B, 0x3E];

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
    /// `pressed` is every modifier key currently down; `left` and `right` are
    /// this chord's own pair.
    fn update(&mut self, pressed: &[u16], left: u16, right: u16) -> bool {
        let down = |code: u16| pressed.contains(&code);
        let foreign = pressed.iter().any(|&code| code != left && code != right);

        if !down(left) && !down(right) {
            self.latched = false;
        }
        if foreign {
            // These keys belong to some other app's shortcut. Wait for a full
            // release before arming again.
            self.latched = true;
        }
        if !(down(left) && down(right)) || foreign {
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

/// Which of the chord keys and Control are down right now.
fn modifiers_down() -> Vec<u16> {
    MODIFIER_CHORDS
        .iter()
        .flat_map(|(_, left, right)| [*left, *right])
        .chain(CONTROL_KEYS)
        .filter(|&code| key_down(code))
        .collect()
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

            let pressed = modifiers_down();

            for (chord, (key, left, right)) in chords.iter_mut().zip(MODIFIER_CHORDS) {
                if !chord.update(&pressed, *left, *right) {
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

    const LEFT: u16 = 0x37;
    const RIGHT: u16 = 0x36;
    const FOREIGN: u16 = CONTROL_KEYS[0];

    fn poll(chord: &mut Chord, pressed: &[u16]) -> bool {
        chord.update(pressed, LEFT, RIGHT)
    }

    /// Both keys down and nothing else, long enough to clear the threshold.
    fn hold(chord: &mut Chord) -> bool {
        let mut fired = false;
        for _ in 0..HOLD_POLLS {
            fired |= poll(chord, &[LEFT, RIGHT]);
        }
        fired
    }

    #[test]
    fn either_order_fires_once_until_both_keys_are_released() {
        for one in [LEFT, RIGHT] {
            let mut chord = Chord::default();
            assert!(!poll(&mut chord, &[]));
            assert!(!poll(&mut chord, &[one]));
            assert!(hold(&mut chord));
            assert!(!hold(&mut chord));
            // One key bouncing while the other stays held must not re-fire.
            assert!(!poll(&mut chord, &[one]));
            assert!(!hold(&mut chord));
            assert!(!poll(&mut chord, &[]));
            assert!(hold(&mut chord));
        }
    }

    #[test]
    fn a_tap_shorter_than_the_hold_threshold_does_not_fire() {
        let mut chord = Chord::default();
        for _ in 0..HOLD_POLLS - 1 {
            assert!(!poll(&mut chord, &[LEFT, RIGHT]));
        }
        assert!(!poll(&mut chord, &[]));
        assert!(!poll(&mut chord, &[LEFT, RIGHT]));
    }

    #[test]
    fn a_foreign_modifier_suppresses_the_chord_until_release() {
        let mut chord = Chord::default();
        for _ in 0..HOLD_POLLS * 2 {
            assert!(!poll(&mut chord, &[LEFT, RIGHT, FOREIGN]));
        }
        // Releasing only the foreign modifier is not enough.
        assert!(!hold(&mut chord));
        assert!(!poll(&mut chord, &[]));
        assert!(hold(&mut chord));
    }

    #[test]
    fn enabling_while_held_requires_release() {
        let mut chord = Chord::default();
        chord.disarm();
        assert!(!hold(&mut chord));
        assert!(!poll(&mut chord, &[LEFT]));
        assert!(!poll(&mut chord, &[]));
        assert!(hold(&mut chord));
    }
}
