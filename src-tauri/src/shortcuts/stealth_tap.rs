//! StealthTap: Captures Right Shift with zero-keylogging OS event swallowing.
//!
//! When the user taps Right Shift (0x3C / 60):
//! 1. An active CGEventTap intercepts the hardware event at the head of the session queue.
//! 2. It detects a rapid double-tap (<320ms).
//! 3. It triggers Omni (toggle window if hidden; screenshot & solve if visible).
//! 4. It returns NULL from the event tap callback, which instructs macOS WindowServer
//!    to swallow and discard the event.
//! 5. Active applications (Chrome, Safari, VS Code) and in-browser keyloggers
//!    (HackerRank, CodeSignal) receive zero keydown/keyup events.
//!
//! If Accessibility permissions are not yet granted, it gracefully falls back to
//! passive CGEventSourceKeyState polling so the shortcut functions under all circumstances.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};
use crate::shortcuts::{handle_screenshot_shortcut, handle_toggle_window};

#[cfg(target_os = "macos")]
use tauri_nspanel::ManagerExt;

static LAST_RIGHT_SHIFT_DOWN: AtomicU64 = AtomicU64::new(0);
static LAST_TRIGGER_TIME: AtomicU64 = AtomicU64::new(0);
static EVENT_TAP_ACTIVE: AtomicBool = AtomicBool::new(false);

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Dispatches the context-sensitive Omni action:
/// - If HUD is hidden -> Show HUD
/// - If HUD is visible -> Trigger screenshot & solve
fn dispatch_stealth_action<R: Runtime>(app: &AppHandle<R>) {
    let now = current_millis();
    let last = LAST_TRIGGER_TIME.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 400 {
        // Debounce triggers
        return;
    }
    LAST_TRIGGER_TIME.store(now, Ordering::Relaxed);

    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let is_visible = {
            #[cfg(target_os = "macos")]
            {
                if let Ok(panel) = handle.get_webview_panel("main") {
                    panel.is_visible()
                } else if let Some(window) = handle.get_webview_window("main") {
                    window.is_visible().unwrap_or(false)
                } else {
                    false
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = handle.get_webview_window("main") {
                    window.is_visible().unwrap_or(false)
                } else {
                    false
                }
            }
        };

        if is_visible {
            // HUD is already open -> Trigger instant screenshot & solve
            handle_screenshot_shortcut(&handle);
        } else {
            // HUD is closed -> Open and focus HUD
            handle_toggle_window(&handle);
        }
    });
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::thread;

    type CGEventTapProxy = *mut std::ffi::c_void;
    type CGEventRef = *mut std::ffi::c_void;
    type CFMachPortRef = *mut std::ffi::c_void;
    type CFRunLoopSourceRef = *mut std::ffi::c_void;

    const K_CG_HID_EVENT_TAP: u32 = 0;
    const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const K_CG_EVENT_TAP_OPTION_DEFAULT: u32 = 0;
    const K_CG_EVENT_FLAGS_CHANGED: u32 = 12;
    const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
    const K_VK_RIGHT_SHIFT: i64 = 0x3C; // 60 decimal
    const NX_SHIFTMASK: u64 = 0x00020000; // Bit 17 in flags

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: extern "C" fn(
                proxy: CGEventTapProxy,
                event_type: u32,
                event: CGEventRef,
                refcon: *mut std::ffi::c_void,
            ) -> CGEventRef,
            refcon: *mut std::ffi::c_void,
        ) -> CFMachPortRef;

        fn CFMachPortCreateRunLoopSource(
            allocator: *mut std::ffi::c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> CFRunLoopSourceRef;

        fn CFRunLoopGetCurrent() -> *mut std::ffi::c_void;
        fn CFRunLoopAddSource(
            rl: *mut std::ffi::c_void,
            source: CFRunLoopSourceRef,
            mode: *const std::ffi::c_void,
        );
        fn CFRunLoopRun();

        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;

        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
    }

    static mut APP_PTR: *const std::ffi::c_void = std::ptr::null();

    extern "C" fn event_tap_callback<R: Runtime>(
        _proxy: CGEventTapProxy,
        event_type: u32,
        event: CGEventRef,
        _refcon: *mut std::ffi::c_void,
    ) -> CGEventRef {
        if event_type == K_CG_EVENT_FLAGS_CHANGED {
            let keycode = unsafe { CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE) };
            if keycode == K_VK_RIGHT_SHIFT {
                let flags = unsafe { CGEventGetFlags(event) };
                let is_down = (flags & NX_SHIFTMASK) != 0;

                if is_down {
                    let now = current_millis();
                    let last = LAST_RIGHT_SHIFT_DOWN.swap(now, Ordering::Relaxed);
                    let delta = now.saturating_sub(last);

                    // If double-tap within 350ms, trigger action
                    if delta > 50 && delta <= 350 {
                        unsafe {
                            if !APP_PTR.is_null() {
                                let app = &*(APP_PTR as *const AppHandle<R>);
                                dispatch_stealth_action(app);
                            }
                        }
                    }
                }

                // SWALLOW THE EVENT: By returning null, macOS drops Right Shift on the floor.
                // No active window (Chrome, HackerRank) receives keydown/keyup events!
                return std::ptr::null_mut();
            }
        }

        // Pass all other keys through untouched
        event
    }

    pub fn start_stealth_tap<R: Runtime>(app: AppHandle<R>) {
        let app_clone = app.clone();
        
        thread::spawn(move || {
            let mask = 1u64 << K_CG_EVENT_FLAGS_CHANGED;
            
            // Box the AppHandle and store static pointer for the C callback
            let boxed_app = Box::new(app_clone);
            unsafe {
                APP_PTR = Box::into_raw(boxed_app) as *const std::ffi::c_void;
            }

            let tap = unsafe {
                CGEventTapCreate(
                    K_CG_HID_EVENT_TAP,
                    K_CG_HEAD_INSERT_EVENT_TAP,
                    K_CG_EVENT_TAP_OPTION_DEFAULT,
                    mask,
                    event_tap_callback::<R>,
                    std::ptr::null_mut(),
                )
            };

            if !tap.is_null() {
                EVENT_TAP_ACTIVE.store(true, Ordering::SeqCst);
                eprintln!("[StealthTap] macOS CGEventTap established. Right Shift event swallowing active ✅");

                unsafe {
                    let source = CFMachPortCreateRunLoopSource(std::ptr::null_mut(), tap, 0);
                    if !source.is_null() {
                        let run_loop = CFRunLoopGetCurrent();
                        CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
                        CFRunLoopRun();
                    }
                }
            } else {
                eprintln!("[StealthTap] CGEventTap creation deferred (fallback to passive polling active)");
            }
        });

        // Background polling fallback (runs if CGEventTap is inactive or waiting on permission)
        let app_polling = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut was_down = false;
            let mut last_tap = Instant::now();

            loop {
                // If event tap is active, let the event tap handle it with swallowing
                if EVENT_TAP_ACTIVE.load(Ordering::Relaxed) {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }

                let is_down = unsafe { CGEventSourceKeyState(0, 0x3C) };
                if is_down && !was_down {
                    let now = Instant::now();
                    let elapsed = now.duration_since(last_tap);
                    if elapsed > Duration::from_millis(50) && elapsed <= Duration::from_millis(350) {
                        dispatch_stealth_action(&app_polling);
                    }
                    last_tap = now;
                }
                was_down = is_down;

                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
    }
}

pub fn init_stealth_tap<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    macos::start_stealth_tap(app.clone());

    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
