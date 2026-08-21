// Stands in for Tauri's IPC bridge so the real UI can run in a plain browser.
// Injected before any app code, because @tauri-apps/api reads
// window.__TAURI_INTERNALS__ at call time.
(() => {
  const calls = [];
  const callbacks = new Map();
  let nextCallbackId = 1;

  // dev-harness/provider-proxy.mjs, which holds the API key so this page never
  // does — the same split the shipped app relies on.
  const PROXY = window.__HARNESS_PROXY__ ?? "http://127.0.0.1:1422";

  const cancelled = new Set();

  /**
   * Delivers messages the way Tauri's IPC bridge delivers them to a Channel:
   * `{index, message}` per chunk and a final `{index, end: true}`. Going through
   * the registered callback rather than poking `channel.onmessage` keeps the real
   * Channel ordering logic in the path.
   */
  const channelSender = (channel) => {
    const id =
      typeof channel === "string"
        ? Number(channel.replace("__CHANNEL__:", ""))
        : channel?.id;
    const entry = callbacks.get(id);
    let index = 0;
    const send = (message) => entry?.callback({ index: index++, message });
    send.end = () => entry?.callback({ index: index++, end: true });
    return send;
  };

  const VAD_CONFIG = {
    enabled: false,
    threshold: 0.5,
    silence_duration_ms: 1000,
    speech_pad_ms: 300,
  };

  /**
   * Forwards a provider request through the proxy and streams the reply back over
   * the channel, mirroring src-tauri/src/provider.rs. TextDecoder in streaming
   * mode holds back a split multi-byte character, which is the same thing
   * `take_complete_utf8` does in Rust.
   */
  const providerRequest = async ({ request, onChunk }) => {
    const emit = channelSender(onChunk);

    const response = await fetch(`${PROXY}/provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    }).catch((error) => {
      throw new Error(
        `Harness proxy unreachable at ${PROXY}. Start it with \`npm run dev:live\`. (${error.message})`
      );
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error ?? `Harness proxy returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (cancelled.has(request.requestId)) break;
      const text = decoder.decode(value, { stream: true });
      if (text) emit(text);
    }
    emit.end();
    cancelled.delete(request.requestId);
    return null;
  };

  /**
   * The app's own capture is a native screen grab no browser can perform, so the
   * proxy serves a fixture PNG instead. Falls back to an empty string when the
   * proxy is not running, which is the layout-only probe's case.
   */
  const captureToBase64 = async () => {
    try {
      const response = await fetch(`${PROXY}/capture`);
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        console.warn(
          `[harness] capture_to_base64: ${detail?.error ?? response.status}`
        );
        return "";
      }
      const { base64, bytes, path } = await response.json();
      console.log(`[harness] capture fixture ${path} (${bytes} bytes)`);
      return base64;
    } catch (error) {
      console.warn(
        `[harness] capture_to_base64: proxy unreachable at ${PROXY} (${error.message})`
      );
      return "";
    }
  };

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
    capture_to_base64: captureToBase64,
    start_screen_capture: () => null,
    capture_selected_area: () => null,
    close_overlay_window: () => null,
    // System-audio capture has no working backend on macOS right now: the
    // real implementation needs CoreAudio process taps via `cidre`, whose
    // build script requires a full Xcode install, so
    // src-tauri/src/speaker/macos.rs ships a stub where every entry point
    // reports the feature unavailable instead of failing silently. This is
    // not a mock bug: reporting "unavailable" here mirrors what production
    // actually does today. Flipping it back to look functional is the exact
    // failure this harness exists to catch (it is what let a fabricated
    // waveform pass as a working capture pipeline before).
    check_system_audio_access: () => false,
    request_system_audio_access: () => true,
    start_system_audio_capture: () => null,
    stop_system_audio_capture: () => null,
    manual_stop_continuous: () => null,
    get_vad_config: () => VAD_CONFIG,
    update_vad_config: () => null,
    // Real command returns a bare bool (speaker/commands.rs get_capture_status),
    // not an object.
    get_capture_status: () => false,
    get_audio_sample_rate: () => 48000,
    // Rejects, matching src-tauri/src/speaker/macos.rs get_output_devices. The
    // macOS build cannot capture system audio at all: the real implementation
    // needs CoreAudio process taps via cidre, which needs a full Xcode install.
    // Resolving an empty list here would let the harness pass while the shipped
    // app fails, which is the bug this mock previously hid.
    get_output_devices: () => {
      throw new Error("system audio capture is not available in this build");
    },

    provider_request: providerRequest,
    provider_request_cancel: ({ requestId }) => {
      cancelled.add(requestId);
      return null;
    },

    // The credential store has no browser equivalent. Reporting "stored" is
    // truthful here: the proxy really does hold the key.
    secret_store: () => null,
    secret_delete: () => null,
    secret_exists: () => true,
  };

  // tauri-plugin-sql returns `[rowsAffected, lastInsertId]` from execute and the
  // JS wrapper destructures it. Returning an object made every conversation save
  // fail with "{} is not iterable", which surfaced in the UI as a save error.
  let nextInsertId = 1;

  const pluginResponse = (cmd, args) => {
    if (cmd.startsWith("plugin:sql|")) {
      if (cmd.endsWith("load")) return args?.db ?? "sqlite:harness.db";
      if (cmd.endsWith("select")) return [];
      if (cmd.endsWith("execute")) return [1, nextInsertId++];
      if (cmd.endsWith("close")) return true;
      return null;
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
      const value = handler ? handler(args) : pluginResponse(cmd, args);
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
