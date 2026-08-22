import { Button, Header, Input } from "@/components";
import { useProviderSecret } from "@/hooks";
import { AlertTriangleIcon, CheckIcon, KeyIcon, TrashIcon } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * How long a remove stays armed. It disarms on a timer rather than on blur:
 * WebKit does not focus a button on click, so in WKWebView, which is what the
 * app ships in, an onBlur handler never fires and the confirmation would stay
 * armed until the panel unmounted.
 */
const CONFIRM_WINDOW_MS = 4000;

interface ApiKeyFieldProps {
  providerId: string;
  /** What to call the provider in copy, e.g. "openai" or "custom provider". */
  providerLabel: string;
  /** Any URL the key may be sent to. Its origin is what the key gets bound to. */
  endpoint: string | null;
}

const hostOf = (endpoint: string | null): string | null => {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
};

/**
 * Writes a provider key straight to the OS credential store.
 *
 * The value is never held in app state or localStorage, so the field cannot
 * show it back and reports whether one is saved instead.
 */
export const ApiKeyField = ({
  providerId,
  providerLabel,
  endpoint,
}: ApiKeyFieldProps) => {
  const [draft, setDraft] = useState("");
  // Removing a key is not recoverable: the value only exists in the keychain,
  // so a stray click on a 44px target would mean re-finding it at the provider.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const secret = useProviderSecret(providerId, "API_KEY", endpoint);
  const host = hostOf(endpoint);

  const save = () => {
    void secret.save(draft).then(() => setDraft(""));
  };

  const remove = () => {
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    setConfirmingRemove(false);
    void secret.clear();
  };

  useEffect(() => {
    if (!confirmingRemove) return;
    const timer = setTimeout(
      () => setConfirmingRemove(false),
      CONFIRM_WINDOW_MS
    );
    return () => clearTimeout(timer);
  }, [confirmingRemove]);

  return (
    <div className="space-y-2">
      <Header
        title="API Key"
        description={
          secret.configured
            ? "Saved to your keychain. Omni reads it from there when it sends a request, so the app never stores a copy."
            : `Enter your ${providerLabel} API key. It goes straight to your keychain, not into the app.`
        }
      />

      <div className="flex gap-2">
        <Input
          type="password"
          name="api-key"
          aria-label="API key"
          autoComplete="off"
          spellCheck={false}
          placeholder={secret.configured ? "Saved" : "**********"}
          value={draft}
          onChange={(value) =>
            setDraft(typeof value === "string" ? value : value.target.value)
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          disabled={secret.pending}
          className="flex-1 h-11 border-1 border-input/50 focus:border-primary/50 transition-colors"
        />

        {secret.configured && !draft.trim() ? (
          <Button
            onClick={remove}
            disabled={secret.pending}
            size="icon"
            variant="destructive"
            className="shrink-0 h-11 w-11"
            title={confirmingRemove ? "Confirm remove key" : "Remove key"}
            aria-label={confirmingRemove ? "Confirm remove key" : "Remove key"}
          >
            {confirmingRemove ? (
              <AlertTriangleIcon className="h-4 w-4" />
            ) : (
              <TrashIcon className="h-4 w-4" />
            )}
          </Button>
        ) : (
          <Button
            onClick={save}
            disabled={secret.pending || !draft.trim()}
            size="icon"
            className="shrink-0 h-11 w-11"
            title="Save key"
            aria-label="Save key"
          >
            <KeyIcon className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div aria-live="polite">
        {confirmingRemove ? (
          <p className="text-[11px] text-destructive">
            Press again to remove the key. Omni cannot recover it, so you would
            paste a new one from {providerLabel}.
          </p>
        ) : secret.configured ? (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <CheckIcon className="h-3 w-3 mt-0.5 shrink-0" />
            <span>Key saved{host ? `, and only ever sent to ${host}` : ""}</span>
          </p>
        ) : null}
      </div>

      {secret.error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {secret.error}
        </p>
      ) : null}
    </div>
  );
};
