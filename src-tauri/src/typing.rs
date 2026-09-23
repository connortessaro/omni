use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static TYPING_ACTIVE: AtomicBool = AtomicBool::new(false);
static CANCEL_TYPING: AtomicBool = AtomicBool::new(false);

struct TypingGuard;
impl Drop for TypingGuard {
    fn drop(&mut self) {
        TYPING_ACTIVE.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn cancel_human_typing() -> Result<(), String> {
    CANCEL_TYPING.store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepEffect {
    None,
    TypeUnicode(char),
    TypeBackspace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypingState {
    Idle,
    PlanningNext { char_index: usize },
    TypoKeyDown { wrong_char: char, dwell_ms: u64, char_index: usize },
    TypoReactionPause { reaction_ms: u64, char_index: usize },
    BackspaceDown { dwell_ms: u64, char_index: usize },
    CorrectionHesitation { hesitation_ms: u64, char_index: usize },
    KeyDown { ch: char, dwell_ms: u64, char_index: usize },
    InterKeyDelay { delay_ms: u64, char_index: usize },
    ReadingPause { pause_ms: u64, next_index: usize },
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypingStep {
    pub previous_state: TypingState,
    pub next_state: TypingState,
    pub effect: StepEffect,
    pub wait_duration: Duration,
}

pub fn get_adjacent_typo(ch: char) -> Option<char> {
    let lower = ch.to_ascii_lowercase();
    let typo_lower = match lower {
        'a' => Some('s'), 'b' => Some('v'), 'c' => Some('x'), 'd' => Some('f'),
        'e' => Some('r'), 'f' => Some('g'), 'g' => Some('h'), 'h' => Some('j'),
        'i' => Some('o'), 'j' => Some('k'), 'k' => Some('l'), 'l' => Some('k'),
        'm' => Some('n'), 'n' => Some('m'), 'o' => Some('p'), 'p' => Some('o'),
        'r' => Some('t'), 's' => Some('a'), 't' => Some('y'), 'u' => Some('y'),
        'v' => Some('b'), 'w' => Some('e'), 'x' => Some('c'), 'y' => Some('u'),
        _ => None,
    }?;
    if ch.is_ascii_uppercase() {
        Some(typo_lower.to_ascii_uppercase())
    } else {
        Some(typo_lower)
    }
}

pub struct TypingStateMachine {
    text_chars: Vec<char>,
    base_delay_ms: u64,
    current_state: TypingState,
    rng_state: u64,
}

impl TypingStateMachine {
    pub fn new(text: String, wpm: u32) -> Self {
        let target_wpm = wpm.clamp(30, 250);
        let base_delay_ms = (60_000.0 / (target_wpm as f64 * 5.0)) as u64;
        Self {
            text_chars: text.chars().collect(),
            base_delay_ms,
            current_state: TypingState::Idle,
            rng_state: 123456789,
        }
    }

    #[allow(dead_code)]
    pub fn state(&self) -> &TypingState {
        &self.current_state
    }

    #[allow(dead_code)]
    pub fn is_terminal(&self) -> bool {
        matches!(self.current_state, TypingState::Completed | TypingState::Cancelled)
    }

    pub fn cancel(&mut self) {
        self.current_state = TypingState::Cancelled;
    }

    fn next_rng(&mut self) -> u64 {
        self.rng_state = self.rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.rng_state
    }

    pub fn step(&mut self, is_cancelled: bool) -> Option<TypingStep> {
        if is_cancelled || self.is_terminal() {
            if !self.is_terminal() {
                let prev = self.current_state.clone();
                self.current_state = TypingState::Cancelled;
                return Some(TypingStep {
                    previous_state: prev,
                    next_state: TypingState::Cancelled,
                    effect: StepEffect::None,
                    wait_duration: Duration::ZERO,
                });
            }
            return None;
        }

        let previous = self.current_state.clone();

        match &previous {
            TypingState::Idle => {
                let next = TypingState::PlanningNext { char_index: 0 };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::None,
                    wait_duration: Duration::from_millis(200), // initial focus pause
                })
            }

            TypingState::PlanningNext { char_index } => {
                let idx = *char_index;
                if idx >= self.text_chars.len() {
                    let next = TypingState::Completed;
                    self.current_state = next.clone();
                    return Some(TypingStep {
                        previous_state: previous,
                        next_state: next,
                        effect: StepEffect::None,
                        wait_duration: Duration::ZERO,
                    });
                }

                let ch = self.text_chars[idx];
                let rng = self.next_rng();

                // Realistic human typo check: ~1.5% chance to mis-hit adjacent key on alphabetic after first few chars
                let should_typo = (rng % 65 == 0) && ch.is_alphabetic() && idx > 5;
                if should_typo {
                    if let Some(wrong_char) = get_adjacent_typo(ch) {
                        let dwell_ms = 15 + (rng % 15);
                        let next = TypingState::TypoKeyDown { wrong_char, dwell_ms, char_index: idx };
                        self.current_state = next.clone();
                        return Some(TypingStep {
                            previous_state: previous,
                            next_state: next,
                            effect: StepEffect::TypeUnicode(wrong_char),
                            wait_duration: Duration::from_millis(dwell_ms),
                        });
                    }
                }

                // Normal character keystroke
                let dwell_ms = 15 + (rng % 15);
                let next = TypingState::KeyDown { ch, dwell_ms, char_index: idx };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::TypeUnicode(ch),
                    wait_duration: Duration::from_millis(dwell_ms),
                })
            }

            TypingState::TypoKeyDown { char_index, .. } => {
                let rng = self.next_rng();
                let reaction_ms = 90 + (rng % 50);
                let next = TypingState::TypoReactionPause { reaction_ms, char_index: *char_index };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::None,
                    wait_duration: Duration::from_millis(reaction_ms),
                })
            }

            TypingState::TypoReactionPause { char_index, .. } => {
                let rng = self.next_rng();
                let dwell_ms = 15 + (rng % 15);
                let next = TypingState::BackspaceDown { dwell_ms, char_index: *char_index };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::TypeBackspace,
                    wait_duration: Duration::from_millis(dwell_ms),
                })
            }

            TypingState::BackspaceDown { char_index, .. } => {
                let rng = self.next_rng();
                let hesitation_ms = 70 + (rng % 50);
                let next = TypingState::CorrectionHesitation { hesitation_ms, char_index: *char_index };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::None,
                    wait_duration: Duration::from_millis(hesitation_ms),
                })
            }

            TypingState::CorrectionHesitation { char_index, .. } => {
                let idx = *char_index;
                let ch = self.text_chars[idx];
                let rng = self.next_rng();
                let dwell_ms = 15 + (rng % 15);
                let next = TypingState::KeyDown { ch, dwell_ms, char_index: idx };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::TypeUnicode(ch),
                    wait_duration: Duration::from_millis(dwell_ms),
                })
            }

            TypingState::KeyDown { ch, char_index, .. } => {
                let idx = *char_index;
                let c = *ch;
                let rng = self.next_rng();
                let jitter_factor = ((rng % 60) as i64) - 30;
                let mut delay_ms = (self.base_delay_ms as i64 + jitter_factor).max(35) as u64;

                if c == '\n' {
                    delay_ms += 180;
                } else if c == ';' || c == '{' || c == '}' || c == ':' {
                    delay_ms += 80;
                } else if c == ' ' {
                    delay_ms += 30;
                }

                let next = TypingState::InterKeyDelay { delay_ms, char_index: idx };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::None,
                    wait_duration: Duration::from_millis(delay_ms),
                })
            }

            TypingState::InterKeyDelay { char_index, .. } => {
                let idx = *char_index;
                let next_idx = idx + 1;
                let rng = self.next_rng();

                if idx > 0 && idx % 50 == 0 {
                    let pause_ms = 250 + (rng % 200);
                    let next = TypingState::ReadingPause { pause_ms, next_index: next_idx };
                    self.current_state = next.clone();
                    Some(TypingStep {
                        previous_state: previous,
                        next_state: next,
                        effect: StepEffect::None,
                        wait_duration: Duration::from_millis(pause_ms),
                    })
                } else {
                    let next = TypingState::PlanningNext { char_index: next_idx };
                    self.current_state = next.clone();
                    Some(TypingStep {
                        previous_state: previous,
                        next_state: next,
                        effect: StepEffect::None,
                        wait_duration: Duration::ZERO,
                    })
                }
            }

            TypingState::ReadingPause { next_index, .. } => {
                let next = TypingState::PlanningNext { char_index: *next_index };
                self.current_state = next.clone();
                Some(TypingStep {
                    previous_state: previous,
                    next_state: next,
                    effect: StepEffect::None,
                    wait_duration: Duration::ZERO,
                })
            }

            TypingState::Completed | TypingState::Cancelled => None,
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn simulate_human_typing(text: String, speed_wpm: Option<u32>) -> Result<(), String> {
    if TYPING_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("Typing simulation is already in progress".to_string());
    }
    CANCEL_TYPING.store(false, Ordering::SeqCst);

    struct AbortOnDrop;
    impl Drop for AbortOnDrop {
        fn drop(&mut self) {
            CANCEL_TYPING.store(true, Ordering::SeqCst);
        }
    }
    let abort_guard = AbortOnDrop;

    let res = tokio::task::spawn_blocking(move || {
        let _guard = TypingGuard;
        macos::run_typing(text, speed_wpm.unwrap_or(100))
    })
    .await
    .map_err(|e| e.to_string())?;

    std::mem::forget(abort_guard);
    res
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

    /// Responsive sleep that polls CANCEL_TYPING every 10ms for instant interruption
    fn cancellable_sleep(duration: Duration) -> bool {
        let step = Duration::from_millis(10);
        let mut elapsed = Duration::ZERO;
        while elapsed < duration {
            if CANCEL_TYPING.load(Ordering::SeqCst) {
                return false;
            }
            let slice = (duration - elapsed).min(step);
            sleep(slice);
            elapsed += slice;
        }
        !CANCEL_TYPING.load(Ordering::SeqCst)
    }

    fn post_unicode_char(ch: char) {
        let mut utf16_buf = [0u16; 2];
        let encoded = ch.encode_utf16(&mut utf16_buf);

        unsafe {
            let event_down = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, true);
            if !event_down.is_null() {
                CGEventKeyboardSetUnicodeString(event_down, encoded.len() as u32, encoded.as_ptr());
                CGEventPost(K_CG_HID_EVENT_TAP, event_down);
                CFRelease(event_down);
            }

            let event_up = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, false);
            if !event_up.is_null() {
                CGEventKeyboardSetUnicodeString(event_up, encoded.len() as u32, encoded.as_ptr());
                CGEventPost(K_CG_HID_EVENT_TAP, event_up);
                CFRelease(event_up);
            }
        }
    }

    fn post_backspace() {
        unsafe {
            let event_down = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0x33, true);
            if !event_down.is_null() {
                CGEventPost(K_CG_HID_EVENT_TAP, event_down);
                CFRelease(event_down);
            }
            let event_up = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0x33, false);
            if !event_up.is_null() {
                CGEventPost(K_CG_HID_EVENT_TAP, event_up);
                CFRelease(event_up);
            }
        }
    }

    pub fn run_typing(text: String, wpm: u32) -> Result<(), String> {
        let mut machine = TypingStateMachine::new(text, wpm);

        while let Some(step) = machine.step(CANCEL_TYPING.load(Ordering::SeqCst)) {
            match step.effect {
                StepEffect::TypeUnicode(ch) => post_unicode_char(ch),
                StepEffect::TypeBackspace => post_backspace(),
                StepEffect::None => {}
            }

            if step.wait_duration > Duration::ZERO {
                if !cancellable_sleep(step.wait_duration) {
                    machine.cancel();
                    break;
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_initializes_and_completes() {
        let mut machine = TypingStateMachine::new("fn main()".to_string(), 100);
        assert_eq!(machine.state(), &TypingState::Idle);

        let mut step_count = 0;
        while let Some(_step) = machine.step(false) {
            step_count += 1;
            if machine.is_terminal() {
                break;
            }
            assert!(step_count < 1000);
        }
        assert_eq!(machine.state(), &TypingState::Completed);
    }

    #[test]
    fn state_machine_cancels_immediately() {
        let mut machine = TypingStateMachine::new("fn long_computation_code()".to_string(), 100);
        let _ = machine.step(false);
        assert!(!machine.is_terminal());

        let step = machine.step(true);
        assert_eq!(machine.state(), &TypingState::Cancelled);
        assert!(machine.is_terminal());
        assert!(step.is_some());
        assert_eq!(step.unwrap().next_state, TypingState::Cancelled);
    }

    #[test]
    fn state_machine_generates_correct_actions() {
        let text = "let x = 1;\nreturn x + 2;";
        let mut machine = TypingStateMachine::new(text.to_string(), 120);
        let mut typed_chars = Vec::new();

        while let Some(step) = machine.step(false) {
            match step.effect {
                StepEffect::TypeUnicode(ch) => typed_chars.push(ch),
                StepEffect::TypeBackspace => {
                    typed_chars.pop();
                }
                StepEffect::None => {}
            }
        }
        assert_eq!(machine.state(), &TypingState::Completed);
        let final_string: String = typed_chars.into_iter().collect();
        assert_eq!(final_string, text);
    }

    #[test]
    fn adjacent_typo_mapping_works() {
        assert_eq!(get_adjacent_typo('a'), Some('s'));
        assert_eq!(get_adjacent_typo('c'), Some('x'));
        assert_eq!(get_adjacent_typo('1'), None);
    }
}
