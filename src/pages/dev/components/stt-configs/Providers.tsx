import { Header, Selection, TextInput } from "@/components";
import { endpointFor, isSecretVariable } from "@/lib";
import { UseSettingsReturn } from "@/types";
import curl2Json, { ResultJSON } from "@bany/curl-to-json";
import { useEffect, useState } from "react";
import { ApiKeyField } from "../ApiKeyField";

export const Providers = ({
  allSttProviders,
  selectedSttProvider,
  onSetSelectedSttProvider,
  sttVariables,
}: UseSettingsReturn) => {
  const [localSelectedProvider, setLocalSelectedProvider] =
    useState<ResultJSON | null>(null);

  useEffect(() => {
    if (selectedSttProvider?.provider) {
      const provider = allSttProviders?.find(
        (p) => p?.id === selectedSttProvider?.provider
      );
      if (provider) {
        const json = curl2Json(provider?.curl);
        setLocalSelectedProvider(json as ResultJSON);
      }
    }
  }, [selectedSttProvider?.provider]);

  const findKeyAndValue = (key: string) => {
    return sttVariables?.find((v) => v?.key === key);
  };

  const activeProvider = allSttProviders?.find(
    (p) => p?.id === selectedSttProvider?.provider
  );

  // The endpoint a key gets bound to has to be derived without the key in it,
  // or providers that authenticate in the query string would bind to an origin
  // containing their own credential.
  const nonSecretVariables = Object.fromEntries(
    Object.entries(selectedSttProvider?.variables ?? {})
      .filter(([name]) => !isSecretVariable(name))
      .map(([name, value]) => [name.toUpperCase(), value])
  );

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Header
          title="Select STT Provider"
          description="Select your preferred STT service provider or custom providers to get started."
        />
        <Selection
          selected={selectedSttProvider?.provider}
          options={allSttProviders?.map((provider) => {
            const json = curl2Json(provider?.curl);
            return {
              label: provider?.isCustom
                ? json?.url || "Custom Provider"
                : provider?.id || "Custom Provider",
              value: provider?.id || "Custom Provider",
              isCustom: provider?.isCustom,
            };
          })}
          placeholder="Choose your STT provider"
          onChange={(value) => {
            onSetSelectedSttProvider({
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
      {findKeyAndValue("api_key") && selectedSttProvider?.provider ? (
        <ApiKeyField
          providerId={selectedSttProvider.provider}
          providerLabel={
            activeProvider?.isCustom
              ? "custom provider"
              : selectedSttProvider.provider
          }
          endpoint={
            activeProvider?.curl
              ? endpointFor(activeProvider.curl, nonSecretVariables)
              : null
          }
        />
      ) : null}

      <div className="space-y-4 mt-2">
        {sttVariables
          ?.filter(
            (variable) => variable?.key !== findKeyAndValue("api_key")?.key
          )
          .map((variable) => {
            const getVariableValue = () => {
              if (!variable?.key || !selectedSttProvider?.variables) return "";
              return selectedSttProvider.variables[variable.key] || "";
            };

            return (
              <div className="space-y-1" key={variable?.key}>
                <Header
                  title={variable?.value || ""}
                  description={`add your preferred ${variable?.key?.replace(
                    /_/g,
                    " "
                  )} for ${
                    allSttProviders?.find(
                      (p) => p?.id === selectedSttProvider?.provider
                    )?.isCustom
                      ? "Custom Provider"
                      : selectedSttProvider?.provider
                  }`}
                />
                <TextInput
                  placeholder={`Enter ${
                    allSttProviders?.find(
                      (p) => p?.id === selectedSttProvider?.provider
                    )?.isCustom
                      ? "Custom Provider"
                      : selectedSttProvider?.provider
                  } ${variable?.key?.replace(/_/g, " ") || "value"}`}
                  value={getVariableValue()}
                  onChange={(value) => {
                    if (!variable?.key || !selectedSttProvider) return;

                    onSetSelectedSttProvider({
                      ...selectedSttProvider,
                      variables: {
                        ...selectedSttProvider.variables,
                        [variable.key]: value,
                      },
                    });
                  }}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
};
