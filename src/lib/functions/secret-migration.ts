import { invoke } from "@tauri-apps/api/core";
import curl2Json from "@bany/curl-to-json";
import { deepVariableReplacer } from "./common.function";
import { isSecretVariable } from "./transport";

/**
 * Copies provider credentials out of localStorage into the OS credential store.
 *
 * Deliberately a copy, not a move. The provider request path reads secrets from
 * the credential store, but model listing and speech-to-text still read them from
 * localStorage, so removing them here would break both. The localStorage copy
 * goes away in the change that converts those two paths.
 */

interface ProviderLike {
  id?: string;
  curl?: string;
}

interface SelectedProvider {
  provider: string;
  variables?: Record<string, string>;
}

/** The endpoint a secret is allowed to be sent to, from the provider's own curl. */
export const endpointFor = (
  curl: string,
  variables: Record<string, string>
): string | null => {
  try {
    const parsed = curl2Json(curl);
    // curl2Json percent-encodes the URL, so a {{VAR}} in the path arrives as
    // %7B%7BVAR%7D%7D and leaves deepVariableReplacer nothing to match. It also
    // lower-cases the host, which is why the name is put back into upper case:
    // azure-stt carries {{REGION}} in its host, and without this the endpoint
    // keeps the placeholder, the secret binds to a nonsense origin, and every
    // request to it is refused.
    const raw = (parsed.url ?? "")
      .replace(/%7B%7B/gi, "{{")
      .replace(/%7D%7D/gi, "}}")
      .replace(
        /\{\{([A-Za-z0-9_]+)\}\}/g,
        (_match: string, name: string) => `{{${name.toUpperCase()}}}`
      );
    const url = deepVariableReplacer(raw, variables) as string;
    return url && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
};

export const migrateProviderSecrets = async (
  selected: SelectedProvider | null | undefined,
  providers: ProviderLike[]
): Promise<void> => {
  if (!selected?.provider || !selected.variables) return;

  const provider = providers.find((candidate) => candidate.id === selected.provider);
  if (!provider?.curl) return;

  // Non-secret variables only, or the endpoint would contain the key itself for
  // providers that authenticate via the query string.
  const safeVariables = Object.fromEntries(
    Object.entries(selected.variables)
      .filter(([name]) => !isSecretVariable(name))
      .map(([name, value]) => [name.toUpperCase(), value])
  );

  const endpoint = endpointFor(provider.curl, safeVariables);
  if (!endpoint) return;

  for (const [name, value] of Object.entries(selected.variables)) {
    if (!isSecretVariable(name) || !value) continue;

    const upperName = name.toUpperCase();
    try {
      const alreadyStored = await invoke<boolean>("secret_exists", {
        providerId: selected.provider,
        name: upperName,
      });
      if (alreadyStored) continue;

      await invoke("secret_store", {
        providerId: selected.provider,
        name: upperName,
        value,
        endpoint,
      });
    } catch (error) {
      // A failed migration must not stop the app from starting; the request path
      // reports the missing secret with an actionable message.
      console.error(`Could not migrate ${upperName} to the credential store:`, error);
    }
  }
};
