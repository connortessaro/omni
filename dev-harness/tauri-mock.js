// Stands in for Tauri's IPC bridge so the real UI can run in a plain browser.
// Injected before any app code, because @tauri-apps/api reads
// window.__TAURI_INTERNALS__ at call time.
(() => {
  const calls = [];
  const callbacks = new Map();
  let nextCallbackId = 1;

  const VAD_CONFIG = {
    enabled: false,
    threshold: 0.5,
    silence_duration_ms: 1000,
    speech_pad_ms: 300,
  };

  const AUDIO_DEVICES = [{ id: "mock-device", name: "Mock Audio Device" }];

  const responses = {
    get_app_version: () => "0.0.0-harness",
    set_window_height: () => null,
    open_dashboard: () => null,
    toggle_dashboard: () => null,
    move_window: () => null,
    exit_app: () => null,
    set_app_icon_visibility: () => null,
    set_always_on_top: () => null,
    update_shortcuts: () => null,
    check_shortcuts_registered: () => true,
    get_registered_shortcuts: () => ({}),
    validate_shortcut_key: () => true,
    capture_to_base64: () => "",
    start_screen_capture: () => null,
    capture_selected_area: () => null,
    close_overlay_window: () => null,
    check_system_audio_access: () => true,
    request_system_audio_access: () => true,
    start_system_audio_capture: () => null,
    stop_system_audio_capture: () => null,
    manual_stop_continuous: () => null,
    get_vad_config: () => VAD_CONFIG,
    update_vad_config: () => null,
    get_capture_status: () => ({ is_capturing: false }),
    get_audio_sample_rate: () => 48000,
    get_input_devices: () => AUDIO_DEVICES,
    get_output_devices: () => AUDIO_DEVICES,
  };

  const pluginResponse = (cmd) => {
    if (cmd.startsWith("plugin:sql|")) {
      return cmd.endsWith("select") ? [] : { rowsAffected: 0, lastInsertId: 0 };
    }
    if (cmd.startsWith("plugin:autostart|")) return false;
    if (cmd.startsWith("plugin:global-shortcut|")) return false;
    if (cmd.startsWith("plugin:macos-permissions|")) return true;
    if (cmd.startsWith("plugin:updater|")) return null;
    if (cmd.startsWith("plugin:event|")) return nextCallbackId++;
    return null;
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },

    transformCallback(callback, once = false) {
      const id = nextCallbackId++;
      callbacks.set(id, { callback, once });
      return id;
    },

    unregisterCallback(id) {
      callbacks.delete(id);
    },

    convertFileSrc(filePath) {
      return filePath;
    },

    invoke(cmd, args) {
      calls.push({ cmd, args });
      const handler = responses[cmd];
      const value = handler ? handler(args) : pluginResponse(cmd);
      return Promise.resolve(value);
    },
  };

  // The event plugin reaches for its own globals, separate from the core bridge.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  };

  // What the probe reads back.
  window.__HARNESS__ = {
    calls,
    callsFor(cmd) {
      return calls.filter((call) => call.cmd === cmd);
    },
    lastWindowHeight() {
      const heights = calls
        .filter((call) => call.cmd === "set_window_height")
        .map((call) => call.args?.height);
      return heights.length ? heights[heights.length - 1] : null;
    },
    reset() {
      calls.length = 0;
    },
  };
})();
