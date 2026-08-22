import {
  deepVariableReplacer,
  getByPath,
  blobToBase64,
} from "./common.function";
import {
  isSecretVariable,
  secretPlaceholder,
  streamProviderRequest,
  type RequestUpload,
} from "./transport";

import { TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";

export interface STTParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  audio: File | Blob;
}

// Conventional file extensions for the audio MIME types this app's recorders
// can produce. STT endpoints (OpenAI Whisper and most compatible APIs)
// dispatch on the filename extension, so every upload needs a name that
// actually matches its content instead of a hardcoded "audio.wav".
const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

function getAudioFileName(mimeType: string): string {
  const essence = mimeType.split(";")[0].trim().toLowerCase();
  const knownExtension = AUDIO_EXTENSION_BY_MIME[essence];
  if (knownExtension) return `audio.${knownExtension}`;

  // Unrecognised type: derive the extension from the subtype (e.g.
  // "audio/aac" -> "audio.aac") instead of guessing a specific known format.
  const subtype = essence.split("/")[1];
  return `audio.${subtype || "wav"}`;
}

/**
 * Transcribes audio and returns either the transcription or an error/warning message as a single string.
 */
export async function fetchSTT(params: STTParams): Promise<string> {
  let warnings: string[] = [];

  try {
    const { provider, selectedProvider, audio } = params;

    if (!provider) throw new Error("Provider not provided");
    if (!selectedProvider) throw new Error("Selected provider not provided");
    if (!audio) throw new Error("Audio file is required");

    let curlJson: any;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    // Validate audio file
    const file = audio as File;
    if (file.size === 0) throw new Error("Audio file is empty");
    // maximum size of 10MB
    // const maxSize = 10 * 1024 * 1024;
    // if (file.size > maxSize) {
    //   warnings.push("Audio exceeds 10MB limit");
    // }

    // A credential is replaced by a placeholder, not its value: Rust
    // substitutes the real one at send time, so nothing here ever holds a key.
    const allVariables: Record<string, string> = Object.fromEntries(
      Object.entries(selectedProvider.variables).map(([key, value]) => [
        key.toUpperCase(),
        isSecretVariable(key) ? secretPlaceholder(key.toUpperCase()) : value,
      ])
    );

    // Prepare request.
    //
    // curl2Json percent-encodes the URL, which turns a `{{VAR}}` in the path
    // into `%7B%7BVAR%7D%7D` and leaves deepVariableReplacer nothing to match —
    // the placeholder then ships literally and the provider answers 404, which
    // reads like a bad key. Query-string placeholders already get this
    // treatment further down (decodeURIComponent on each param); the braces are
    // restored rather than decoding the whole URL so that genuinely encoded
    // characters elsewhere in it survive.
    const rawUrl = (curlJson.url || "")
      .replace(/%7B%7B/gi, "{{")
      .replace(/%7D%7D/gi, "}}");
    let url = deepVariableReplacer(rawUrl, allVariables);
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    const formData = deepVariableReplacer(curlJson.form || {}, allVariables);

    // To Check if API accepts Binary Data
    const isBinaryUpload = provider.curl.includes("--data-binary");
    // Fetch URL Params
    const rawParams = curlJson.params || {};
    // Decode Them
    const decodedParams = Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [
        key,
        typeof value === "string" ? decodeURIComponent(value) : "",
      ])
    );
    // Get the Parameters from allVariables
    const replacedParams = deepVariableReplacer(decodedParams, allVariables);

    // Add query parameters to URL
    const queryString = new URLSearchParams(replacedParams).toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }

    const finalHeaders: Record<string, string> = { ...headers };
    let body: string | undefined;
    let upload: RequestUpload | undefined;

    const fileName = getAudioFileName(audio.type);
    const mimeType = audio.type.split(";")[0].trim().toLowerCase();

    const isForm =
      provider.curl.includes("-F ") || provider.curl.includes("--form");

    if (isForm) {
      // curl2Json returns -F entries either keyed by name or, when the flag was
      // unquoted, as numbered "name=value" strings.
      const entries: [string, string][] = [];
      for (const [key, value] of Object.entries(formData)) {
        if (typeof value !== "string") continue;
        if (/^\d+$/.test(key)) {
          const [name, ...rest] = value.split("=");
          entries.push([name, rest.join("=")]);
        } else {
          entries.push([key, value]);
        }
      }

      // The field the audio belongs in is whichever one the template pointed at
      // {{AUDIO}}. Hardcoding "file" uploads under a name speechmatics and
      // rev.ai ignore, and their error reads like a missing file.
      const audioEntry = entries.find(([, value]) => value.includes("{{AUDIO}}"));
      const headerNames = new Set(
        Object.keys(headers).map((name) =>
          name.toUpperCase().replace(/[-_]/g, "")
        )
      );

      const fields = Object.fromEntries(
        entries.filter(
          ([name, value]) =>
            name !== audioEntry?.[0] &&
            value &&
            !headerNames.has(name.toUpperCase().replace(/[-_]/g, ""))
        )
      );

      upload = {
        dataBase64: await blobToBase64(audio),
        field: audioEntry?.[0] ?? "file",
        fileName,
        mimeType,
        fields,
      };
      // Rust owns Content-Type for multipart: it holds the boundary.
      delete finalHeaders["Content-Type"];
    } else if (isBinaryUpload) {
      upload = {
        dataBase64: await blobToBase64(audio),
        fileName,
        mimeType,
      };
    } else {
      // Google-style: JSON payload with base64
      allVariables.AUDIO = await blobToBase64(audio);
      // Providers that take inline audio have to be told what the bytes are.
      // The two recorders disagree — system audio is WAV, the mic goes through
      // WKWebView's MediaRecorder and comes out audio/mp4 — so a template
      // cannot hardcode it.
      allVariables.MIME = mimeType;
      const dataObj = curlJson.data ? { ...curlJson.data } : {};
      body = JSON.stringify(deepVariableReplacer(dataObj, allVariables));
    }

    // Always the Rust client, never the webview's fetch: it bypasses CORS (most
    // provider APIs send no CORS headers) and it keeps the credential in the OS
    // credential store, so injected script has nothing to read and nowhere to
    // send it.
    const method = (curlJson.method || "POST").toUpperCase();
    let responseText = "";
    for await (const chunk of streamProviderRequest({
      providerId: selectedProvider.provider,
      url,
      method,
      headers: finalHeaders,
      body: method === "GET" ? undefined : body,
      upload: method === "GET" ? undefined : upload,
    })) {
      responseText += chunk;
    }
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      return [...warnings, responseText.trim()].filter(Boolean).join("; ");
    }

    // Extract transcription
    const path = provider.responseContentPath || "text";
    const rawTranscription = getByPath(data, path);
    const transcription =
      typeof rawTranscription === "string" ? rawTranscription.trim() : "";

    if (!transcription) {
      throw new Error(
        `STT response did not contain a transcription at path "${path}"`
      );
    }

    // Return transcription with any warnings
    return [...warnings, transcription].filter(Boolean).join("; ");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
}
