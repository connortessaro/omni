import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { secretExists, SECRETS_CHANGED_EVENT } from "@/lib";

/**
 * A provider credential, as much of it as the webview is allowed to know: it
 * can be written, cleared, and asked about, never read.
 */
export const useProviderSecret = (
  providerId: string,
  name: string,
  endpoint: string | null
) => {
  const [configured, setConfigured] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!providerId || !name) {
      setConfigured(false);
      return;
    }
    try {
      setConfigured(await secretExists(providerId, name));
    } catch (cause) {
      setConfigured(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [providerId, name]);

  useEffect(() => {
    void refresh();
    // The startup migration can store a key while this is already mounted, and
    // a boolean read once would keep reporting it as missing.
    const onChanged = () => void refresh();
    window.addEventListener(SECRETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SECRETS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const save = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      if (!endpoint) {
        setError(
          "This provider's curl has no usable https endpoint, so there is nowhere to bind the key. Fix the URL in its template, then save again."
        );
        return;
      }
      setPending(true);
      setError(null);
      try {
        await invoke("secret_store", { providerId, name, value, endpoint });
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [providerId, name, endpoint, refresh]
  );

  const clear = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await invoke("secret_delete", { providerId, name });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [providerId, name, refresh]);

  return { configured, pending, error, save, clear };
};
