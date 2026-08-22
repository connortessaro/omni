import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";
import {
  isSecretVariable,
  secretExists,
  secretPlaceholder,
  streamProviderRequest,
} from "./transport";
import { getResponseSettings, RESPONSE_LENGTHS, LANGUAGES } from "@/lib";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config/constants";

/**
 * Added only when an image is attached.
 *
 * Reading code off a screenshot is accurate to roughly 1.5% of characters, which
 * only matters when the wrong character is an operator. Given a screenshot of
 * `if !matches!(parsed.scheme(), "http" | "https")` the model dropped the `!`,
 * concluded the function rejected http and https, and recommended deleting the
 * check: the guard that stops a stored secret being sent to a `file://` URL. The
 * answer was fluent and cited line numbers.
 *
 * Asked to quote the line verbatim first, the same model on the same screenshot read
 * the `!` and described the behaviour correctly. Quoting does not make it read
 * better, it makes a misreading visible instead of hidden inside a conclusion.
 *
 * The second half addresses the other measured failure: on a full-screen capture the
 * model transcribes about 60% of the visible code and stops, with no sign that the
 * rest went unread.
 */
export const IMAGE_GROUNDING_INSTRUCTIONS =
  "When an attached image contains text you rely on, quote that text verbatim, " +
  "character for character, before drawing any conclusion from it. If part of the " +
  "image is unreadable, or you cannot see all of it, say which part instead of " +
  "filling it in.";

function buildEnhancedSystemPrompt(
  baseSystemPrompt?: string,
  hasImages = false,
  codeIntent = false
): string {
  const responseSettings = getResponseSettings();
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  if (hasImages) {
    prompts.push(IMAGE_GROUNDING_INSTRUCTIONS);
  }

  // A length setting is a preference about prose. On a turn the user explicitly
  // marked as code — a /code, /refactor, /commit or /regex command, or the Code
  // profile being active — appending any sentence cap is a request to truncate a
  // diff, so the option is skipped rather than softened.
  if (!codeIntent) {
    const lengthOption = RESPONSE_LENGTHS.find(
      (l) => l.id === responseSettings.responseLength
    );
    if (lengthOption?.prompt?.trim()) {
      prompts.push(lengthOption.prompt);
    }
  }

  const languageOption = LANGUAGES.find(
    (l) => l.id === responseSettings.language
  );
  if (languageOption?.prompt?.trim()) {
    prompts.push(languageOption.prompt);
  }

  // Add markdown formatting instructions
  prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);

  return prompts.join(" ");
}

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  codeIntent?: boolean;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      codeIntent = false,
      signal,
    } = params;

    // Check if already aborted
    if (signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(
      systemPrompt,
      imagesBase64.length > 0,
      codeIntent
    );

    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      // A credential is not in the variables map any more; it lives in the OS
      // credential store, so its presence is a question for Rust.
      if (isSecretVariable(key)) {
        if (
          !(await secretExists(selectedProvider.provider, key.toUpperCase()))
        ) {
          throw new Error(`Missing ${key.toUpperCase()}. Add it in Dev space.`);
        }
        continue;
      }

      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64
      );
      bodyObj[messagesKey] = finalMessages;
    }

    // A credential is replaced by a placeholder, not its value: Rust substitutes
    // the real one at send time, so nothing here ever holds a key.
    //
    // The placeholder comes from what the template declares, not from what the
    // variables map happens to hold, because the map no longer holds a secret at
    // all. Seeding it only from the map leaves the literal `{{API_KEY}}` in the
    // header, Rust finds no placeholder to substitute, and the provider answers
    // 401 in a way that reads like a bad key.
    const allVariables = {
      ...Object.fromEntries(
        extractedVariables
          .filter(({ key }) => isSecretVariable(key))
          .map(({ key }) => [
            key.toUpperCase(),
            secretPlaceholder(key.toUpperCase()),
          ])
      ),
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          isSecretVariable(key) ? secretPlaceholder(key.toUpperCase()) : value,
        ])
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    let url = deepVariableReplacer(curlJson.url || "", allVariables);

    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    headers["Content-Type"] = "application/json";

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    const method = (curlJson.method || "POST").toUpperCase();
    const stream = streamProviderRequest({
      providerId: selectedProvider.provider,
      url,
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(bodyObj),
      signal,
    });

    if (!provider?.streaming) {
      let raw = "";
      try {
        for await (const chunk of stream) raw += chunk;
      } catch (error) {
        if (signal?.aborted) return;
        yield error instanceof Error ? error.message : String(error);
        return;
      }
      try {
        const json = JSON.parse(raw);
        yield getByPath(json, provider?.responseContentPath || "") || "";
      } catch {
        yield `Failed to parse non-streaming response: ${raw.slice(0, 200)}`;
      }
      return;
    }

    let buffer = "";
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) return;
        buffer += chunk;

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const trimmed = line.substring(5).trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            const parsed = JSON.parse(trimmed);
            const delta = getStreamingContent(
              parsed,
              provider?.responseContentPath || ""
            );
            if (delta) yield delta;
          } catch {
            // Partial JSON across a chunk boundary; the next chunk completes it.
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      yield error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    throw new Error(
      `Error in fetchAIResponse: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}
