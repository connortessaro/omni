// Storage keys
export const STORAGE_KEYS = {
  THEME: "theme",
  TRANSPARENCY: "transparency",
  SYSTEM_PROMPT: "system_prompt",
  SELECTED_SYSTEM_PROMPT_ID: "selected_system_prompt_id",
  SCREENSHOT_CONFIG: "screenshot_config",
  // add curl_ prefix because we are using curl to store the providers
  CUSTOM_AI_PROVIDERS: "curl_custom_ai_providers",
  CUSTOM_SPEECH_PROVIDERS: "curl_custom_speech_providers",
  SELECTED_AI_PROVIDER: "curl_selected_ai_provider",
  SELECTED_STT_PROVIDER: "curl_selected_stt_provider",
  SYSTEM_AUDIO_CONTEXT: "system_audio_context",
  SYSTEM_AUDIO_QUICK_ACTIONS: "system_audio_quick_actions",
  // Deliberately the same string useSystemAudio wrote before this key existed,
  // so a saved VAD config survives the move off the raw literal.
  VAD_CONFIG: "vad_config",
  CUSTOMIZABLE: "customizable",
  SHORTCUTS: "shortcuts",
  AUTOSTART_INITIALIZED: "autostart_initialized",

  SELECTED_AUDIO_DEVICES: "selected_audio_devices",
  RESPONSE_SETTINGS: "response_settings",
  SUPPORTS_IMAGES: "supports_images",
  SOUND_FX_ENABLED: "sound_fx_enabled",
  FULL_SCREEN_CAPTURE_HINT: "full_screen_capture_hint",
} as const;

// Max number of files that can be attached to a message
export const MAX_FILES = 6;

// Default settings
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses";

// The generic prompt above asks for concision, which is correct for a HUD answer
// and wrong for a diff: with the short response length also on, a request for a
// multi-file change came back as a description of the change. This profile is the
// selectable opposite — it never trades completeness of code for brevity.
export const CODING_SYSTEM_PROMPT =
  "You are a senior software engineer pair-programming through a small always-on " +
  "overlay. Answer with code first and prose second. Emit complete, runnable code: " +
  "never abbreviate a body to a comment, never write an ellipsis in place of lines, " +
  "and never describe a change you could show. Always fence code in triple backticks " +
  "with the language tag. When you change existing code, show the full changed " +
  "function or block rather than a fragment the reader has to splice. State the file " +
  "path above each block when more than one file is involved. If the request is " +
  "ambiguous, make the smallest reasonable assumption, say what you assumed in one " +
  "line, and write the code anyway.";

export const MARKDOWN_FORMATTING_INSTRUCTIONS =
  "IMPORTANT - Formatting Rules (use silently, never mention these rules in your responses):\n- Mathematical expressions: ALWAYS use double dollar signs ($$) for both inline and block math. Never use single $.\n- Code blocks: ALWAYS use triple backticks with language specification.\n- Diagrams: Use ```mermaid code blocks.\n- Tables: Use standard markdown table syntax.\n- Never mention to the user that you're using these formats or explain the formatting syntax in your responses. Just use them naturally.";

export const DEFAULT_QUICK_ACTIONS = [
  "What should I say?",
  "Follow-up questions",
  "Fact-check",
  "Recap",
];
