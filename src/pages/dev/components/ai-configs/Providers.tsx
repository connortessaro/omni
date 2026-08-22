import { Button, Header, Selection, TextInput } from "@/components";
import { endpointFor, isSecretVariable } from "@/lib";
import { UseSettingsReturn } from "@/types";
import curl2Json, { ResultJSON } from "@bany/curl-to-json";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useEffect, useState } from "react";
import { ApiKeyField } from "../ApiKeyField";

export const Providers = ({
  allAiProviders,
  selectedAIProvider,
  onSetSelectedAIProvider,
  variables,
}: UseSettingsReturn) => {
  const [localSelectedProvider, setLocalSelectedProvider] =
    useState<ResultJSON | null>(null);
  const [detectedOllamaModels, setDetectedOllamaModels] = useState<string[]>([]);
  const [isDetectingOllama, setIsDetectingOllama] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  const handleDetectOllama = async () => {
    setIsDetectingOllama(true);
    setDetectError(null);
    try {
      const res = await tauriFetch("http://localhost:11434/api/tags");
      if (!res.ok) throw new Error(`Ollama returned status ${res.status}`);
      const data: any = await res.json();
      const models = (data?.models || []).map((m: any) => m.name);
      if (models.length === 0) {
        setDetectError(
          "No models found in Ollama. Pull one in terminal: 'ollama pull llama3.2'"
        );
      } else {
        setDetectedOllamaModels(models);
      }
    } catch {
      setDetectError(
        "Could not connect to Ollama at http://localhost:11434. Is Ollama running?"
      );
    } finally {
      setIsDetectingOllama(false);
    }
  };

  useEffect(() => {
    if (selectedAIProvider?.provider) {
      const provider = allAiProviders?.find(
        (p) => p?.id === selectedAIProvider?.provider
      );
      if (provider) {
        const json = curl2Json(provider?.curl);
        setLocalSelectedProvider(json as ResultJSON);
      }
    }
  }, [selectedAIProvider?.provider]);

  const findKeyAndValue = (key: string) => {
    return variables?.find((v) => v?.key === key);
  };

  const activeProvider = allAiProviders?.find(
    (p) => p?.id === selectedAIProvider?.provider
  );

  // The endpoint a key gets bound to has to be derived without the key in it,
  // or providers that authenticate in the query string would bind to an origin
  // containing their own credential.
  const nonSecretVariables = Object.fromEntries(
    Object.entries(selectedAIProvider?.variables ?? {})
      .filter(([name]) => !isSecretVariable(name))
      .map(([name, value]) => [name.toUpperCase(), value])
  );

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Header
          title="Select AI Provider"
          description="Select your preferred AI service provider or custom providers to get started."
        />
        <Selection
          selected={selectedAIProvider?.provider}
          options={allAiProviders?.map((provider) => {
            const json = curl2Json(provider?.curl);
            return {
              label: provider?.isCustom
                ? json?.url || "Custom Provider"
                : provider?.id || "Custom Provider",
              value: provider?.id || "Custom Provider",
              isCustom: provider?.isCustom,
            };
          })}
          placeholder="Choose your AI provider"
          onChange={(value) => {
            onSetSelectedAIProvider({
              provider: value,
              variables: {},
            });
          }}
        />
      </div>

      {localSelectedProvider ? (
        <Header
          title={`Method: ${
            localSelectedProvider?.method || "Invalid"
          }, Endpoint: ${localSelectedProvider?.url || "Invalid"}`}
          description={`If you want to use different url or method, you can always create a custom provider.`}
        />
      ) : null}

      {findKeyAndValue("api_key") && selectedAIProvider?.provider ? (
        <ApiKeyField
          providerId={selectedAIProvider.provider}
          providerLabel={
            activeProvider?.isCustom
              ? "custom provider"
              : selectedAIProvider.provider
          }
          endpoint={
            activeProvider?.curl
              ? endpointFor(activeProvider.curl, nonSecretVariables)
              : null
          }
        />
      ) : null}

      <div className="space-y-4 mt-2">
        {variables
          .filter(
            (variable) => variable.key !== findKeyAndValue("api_key")?.key
          )
          .map((variable) => {
            const getVariableValue = () => {
              if (!variable?.key || !selectedAIProvider?.variables) return "";
              return selectedAIProvider.variables[variable.key] || "";
            };

            return (
              <div className="space-y-1" key={variable?.key}>
                <Header
                  title={variable?.value || ""}
                  description={`add your preferred ${variable?.key?.replace(
                    /_/g,
                    " "
                  )} for ${
                    allAiProviders?.find(
                      (p) => p?.id === selectedAIProvider?.provider
                    )?.isCustom
                      ? "Custom Provider"
                      : selectedAIProvider?.provider
                  }`}
                />
                <TextInput
                  placeholder={`Enter ${
                    allAiProviders?.find(
                      (p) => p?.id === selectedAIProvider?.provider
                    )?.isCustom
                      ? "Custom Provider"
                      : selectedAIProvider?.provider
                  } ${variable?.key?.replace(/_/g, " ") || "value"}`}
                  value={getVariableValue()}
                  onChange={(value) => {
                    if (!variable?.key || !selectedAIProvider) return;

                    onSetSelectedAIProvider({
                      ...selectedAIProvider,
                      variables: {
                        ...selectedAIProvider.variables,
                        [variable.key]: value,
                      },
                    });
                  }}
                />

                {selectedAIProvider?.provider === "ollama" &&
                  variable?.key?.toLowerCase().includes("model") && (
                    <div className="pt-2">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          className="text-xs h-7 cursor-pointer"
                          disabled={isDetectingOllama}
                          onClick={handleDetectOllama}
                        >
                          {isDetectingOllama
                            ? "Detecting..."
                            : "⚡ Detect Local Models"}
                        </Button>
                      </div>

                      {detectError && (
                        <p className="text-[11px] text-destructive mt-1.5">
                          {detectError}
                        </p>
                      )}

                      {detectedOllamaModels.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {detectedOllamaModels.map((modelName) => (
                            <button
                              key={modelName}
                              type="button"
                              onClick={() => {
                                onSetSelectedAIProvider({
                                  ...selectedAIProvider,
                                  variables: {
                                    ...selectedAIProvider.variables,
                                    [variable.key]: modelName,
                                  },
                                });
                              }}
                              className={`text-xs px-2 py-0.5 rounded-full border transition cursor-pointer ${
                                getVariableValue() === modelName
                                  ? "bg-primary text-primary-foreground border-primary font-medium"
                                  : "bg-muted/50 hover:bg-muted text-muted-foreground border-input/50"
                              }`}
                            >
                              {modelName}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
              </div>
            );
          })}
      </div>
    </div>
  );
};
