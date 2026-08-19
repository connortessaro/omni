// Substitutes Node's global fetch for @tauri-apps/plugin-http, so production
// code that must bypass CORS in the app can still be run from a plain script.
// Only the transport is swapped; URLs, headers, and parsing stay real.
export const fetch = (url, init) => globalThis.fetch(url, init);
