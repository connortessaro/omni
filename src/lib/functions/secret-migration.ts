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
const endpointFor = (
  curl: string,
  variables: Record<string, string>
): string | null => {
  try {
    const parsed = curl2Json(curl);
    const url = deepVariableReplacer(parsed.url ?? "", variables) as string;
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
