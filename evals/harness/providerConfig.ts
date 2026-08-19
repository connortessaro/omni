import { loadSrcModule } from "./loadSrcModule.ts";

export interface RawProvider {
  id: string;
  curl: string;
  responseContentPath: string;
  streaming: boolean;
}

export interface SelectedProvider {
  provider: string;
  variables: Record<string, string>;
}

export interface ResolvedProviderConfig {
  provider: RawProvider;
  selectedProvider: SelectedProvider;
}

// Placeholder defaults so a bare `OMNI_EVAL_PROVIDER=openai` works without
// also having to specify OMNI_EVAL_MODEL. Model catalogs move fast — override
// with OMNI_EVAL_MODEL if one of these 404s against your account.
const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  claude: "claude-3-5-haiku-latest",
  grok: "grok-2-latest",
  gemini: "gemini-2.5-flash",
  mistral: "mistral-small-latest",
  cohere: "command-r",
  groq: "llama-3.1-8b-instant",
  perplexity: "sonar",
  openrouter: "openai/gpt-4o-mini",
  ollama: "llama3.1",
};

export class MissingEvalCredentialsError extends Error {}

export async function loadAiProviders(): Promise<RawProvider[]> {
  const mod = await loadSrcModule<{ AI_PROVIDERS: RawProvider[] }>(
    "config/ai-providers.constants.ts"
  );
  return mod.AI_PROVIDERS;
}

/**
 * Reads OMNI_EVAL_PROVIDER / OMNI_EVAL_API_KEY / OMNI_EVAL_MODEL from the
 * environment and resolves them against the real provider list Omni ships.
 * Throws MissingEvalCredentialsError with a clear, specific message for any
 * missing/invalid piece — callers must treat that as "cannot run live
 * evals" and exit, never fall back to a fake result.
 */
export async function resolveProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedProviderConfig> {
  const providerId = env.OMNI_EVAL_PROVIDER;
  if (!providerId) {
    throw new MissingEvalCredentialsError(
      "OMNI_EVAL_PROVIDER is not set. Set it to one of the provider ids in " +
        "src/config/ai-providers.constants.ts (openai, claude, grok, gemini, " +
        "mistral, cohere, groq, perplexity, openrouter, ollama)."
    );
  }

  const apiKey = env.OMNI_EVAL_API_KEY;
  if (providerId !== "ollama" && !apiKey) {
    throw new MissingEvalCredentialsError(
      "OMNI_EVAL_API_KEY is not set. A live eval run needs a real provider API " +
        "key (the only exception is OMNI_EVAL_PROVIDER=ollama against a local server)."
    );
  }

  const providers = await loadAiProviders();
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new MissingEvalCredentialsError(
      `Unknown OMNI_EVAL_PROVIDER "${providerId}". Known ids: ${providers
        .map((candidate) => candidate.id)
        .join(", ")}.`
    );
  }

  const model = env.OMNI_EVAL_MODEL ?? DEFAULT_MODELS[providerId];
  if (!model) {
    throw new MissingEvalCredentialsError(
      `No default model is known for provider "${providerId}"; set OMNI_EVAL_MODEL explicitly.`
    );
  }

  return {
    provider,
    selectedProvider: {
      provider: providerId,
      variables: { api_key: apiKey ?? "", model },
    },
  };
}
