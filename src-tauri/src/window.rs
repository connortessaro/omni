#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
use tauri::{App, AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

// Offsets from the edges for the Bottom-Right Stealth Corner
const RIGHT_MARGIN: i32 = 32;
const BOTTOM_MARGIN: i32 = 48;
#[allow(dead_code)]
const TOP_OFFSET: i32 = 54;

/// Sets up the main window with custom positioning
pub fn setup_main_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("omni"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    position_window_bottom_right(&window, RIGHT_MARGIN, BOTTOM_MARGIN)?;

    Ok(())
}

/// Positions a window at the bottom right corner of the screen with specified margins
pub fn position_window_bottom_right(
    window: &WebviewWindow,
    right_margin: i32,
    bottom_margin: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        // The primary monitor is not guaranteed to sit at the global origin, so
        // its own position has to be added. Without it, an arrangement where the
        // built-in display sits left of or above the external one parks the HUD
        // off-screen or on the wrong display entirely.
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        let pos_x =
            (monitor_pos.x + monitor_size.width as i32 - window_size.width as i32 - right_margin)
                .max(monitor_pos.x);
        let pos_y =
            (monitor_pos.y + monitor_size.height as i32 - window_size.height as i32
                - bottom_margin)
                .max(monitor_pos.y);

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: pos_x,
            y: pos_y,
        }))?;
    }

    Ok(())
}

/// Positions a window at the top center of the screen with a specified Y offset
#[allow(dead_code)]
pub fn position_window_top_center(
    window: &WebviewWindow,
    y_offset: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get the primary monitor
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        // Calculate center X position
        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;

        // Set the window position
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: y_offset,
        }))?;
    }

    Ok(())
}

/// Future function for centering window completely (both X and Y)
#[allow(dead_code)]
pub fn center_window_completely(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;
        let center_y = (monitor_size.height as i32 - window_size.height as i32) / 2;

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: center_y,
        }))?;
    }

    Ok(())
}

/// Fallback only, for the case where the window cannot report its own size. The real
/// width lives in tauri.conf.json.
const HUD_WIDTH: f64 = 1200.0;

#[tauri::command]
pub fn set_window_height(window: tauri::WebviewWindow, height: u32) -> Result<(), String> {
    use tauri::{LogicalSize, PhysicalPosition, Position, Size};

    // The HUD is anchored to the bottom-right corner of the screen.
    // When the height changes, we pin the bottom edge so the window expands UPWARD
    // rather than pushing down into the macOS dock or off-screen.
    let anchor = window.outer_position().ok();
    let old_size = window.outer_size().ok();
    let scale = window.scale_factor().unwrap_or(1.0);

    let width = window
        .inner_size()
        .ok()
        .and_then(|size| {
            window
                .scale_factor()
                .ok()
                .map(|scale| size.to_logical::<f64>(scale).width)
        })
        .unwrap_or(HUD_WIDTH);

    let new_size = LogicalSize::new(width, height as f64);
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))?;

    if let (Some(pos), Some(old_s)) = (anchor, old_size) {
        let bottom_y = pos.y + old_s.height as i32;
        let new_height_physical = (height as f64 * scale).round() as i32;
        let new_y = bottom_y - new_height_physical;

        window
            .set_position(Position::Physical(PhysicalPosition::new(pos.x, new_y)))
            .map_err(|e| format!("Failed to reposition window: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    show_dashboard_window(&app)
}

#[allow(dead_code)]
pub fn toggle_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        match dashboard_window.is_visible() {
            Ok(true) => {
                // Window is visible, hide it
                dashboard_window
                    .hide()
                    .map_err(|e| format!("Failed to hide dashboard window: {}", e))?;
            }
            Ok(false) => {
                // Window is hidden, show and focus it
                dashboard_window
                    .show()
                    .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
                dashboard_window
                    .set_focus()
                    .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
            }
            Err(e) => {
                return Err(format!("Failed to check dashboard visibility: {}", e));
            }
        }
    } else {
        // Window doesn't exist, create and show it
        show_dashboard_window(&app)?;
    }

    Ok(())
}

#[allow(dead_code)]
pub fn move_window(app: tauri::AppHandle, direction: String, step: i32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let current_pos = window
            .outer_position()
            .map_err(|e| format!("Failed to get window position: {}", e))?;

        let (new_x, new_y) = match direction.as_str() {
            "up" => (current_pos.x, current_pos.y - step),
            "down" => (current_pos.x, current_pos.y + step),
            "left" => (current_pos.x - step, current_pos.y),
            "right" => (current_pos.x + step, current_pos.y),
            _ => return Err(format!("Invalid direction: {}", direction)),
        };

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: new_x,
                y: new_y,
            }))
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    } else {
        return Err("Main window not found".to_string());
    }

    Ok(())
}

pub fn create_dashboard_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, tauri::Error> {
    let base_builder =
        WebviewWindowBuilder::new(app, "dashboard", tauri::WebviewUrl::App("/chats".into()));

    #[cfg(target_os = "macos")]
    let base_builder = base_builder
        .title("System Dashboard")
        .center()
        .decorations(true)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .content_protected(true)
        // Pre-created at startup so show_dashboard_window can reveal it without a
        // build delay; launching visibly splashed a 1200x800 window over the screen
        // on every app start.
        .visible(false)
        .traffic_light_position(LogicalPosition::new(14.0, 18.0));

    #[cfg(not(target_os = "macos"))]
    let base_builder = base_builder
        .title("System Dashboard")
        .center()
        .decorations(true)
        .inner_size(800.0, 600.0)
        .min_inner_size(800.0, 600.0)
        .content_protected(true)
        .visible(false);

    let window = base_builder.build()?;

    // Set up close event handler - hide window instead of destroying it
    setup_dashboard_close_handler(&window);

    Ok(window)
}

/// Sets up the close event handler for the dashboard window
fn setup_dashboard_close_handler<R: Runtime>(window: &WebviewWindow<R>) {
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Prevent the window from being destroyed
            api.prevent_close();
            // Hide the window instead
            if let Err(e) = window_clone.hide() {
                eprintln!("Failed to hide dashboard window on close: {}", e);
            }
        }
    });
}

/// Shows the dashboard window and brings it to focus
pub fn show_dashboard_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        // Window exists, show and focus it
        dashboard_window
            .show()
            .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
        dashboard_window
            .set_focus()
            .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
    } else {
        // Window doesn't exist, create it and then show it
        let window = create_dashboard_window(app)
            .map_err(|e| format!("Failed to create dashboard window: {}", e))?;
        window
            .show()
            .map_err(|e| format!("Failed to show new dashboard window: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus new dashboard window: {}", e))?;
    }
    Ok(())
}
