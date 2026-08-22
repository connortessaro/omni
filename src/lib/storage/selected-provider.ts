import { isSecretVariable } from "@/lib/functions/transport";
import { safeLocalStorage } from "./helper";

/**
 * The only place a selected provider is written to localStorage.
 *
 * Credentials live in the OS credential store. The file behind localStorage is
 * mode 644 and readable by any process running as the user with no prompt,
 * where the keychain copy is ACL-gated, so a variable whose name marks it as a
 * credential is dropped rather than persisted. scripts/check-secret-storage.mjs
 * enforces that nothing else writes these keys.
 */
export const withoutSecrets = (
  variables: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables ?? {}).filter(([name]) => !isSecretVariable(name))
  );

export const persistSelectedProvider = (
  storageKey: string,
  selected: { provider: string; variables: Record<string, string> }
): void => {
  if (!selected?.provider) return;
  safeLocalStorage.setItem(
    storageKey,
    JSON.stringify({
      provider: selected.provider,
      variables: withoutSecrets(selected.variables),
    })
  );
};
