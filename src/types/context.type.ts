import { Dispatch, SetStateAction } from "react";
import { ScreenshotConfig, TYPE_PROVIDER } from "@/types";
import { CursorType, CustomizableState } from "@/lib/storage";

export type IContextType = {
  systemPrompt: string;
  setSystemPrompt: Dispatch<SetStateAction<string>>;
  allAiProviders: TYPE_PROVIDER[];
  customAiProviders: TYPE_PROVIDER[];
  selectedAIProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  onSetSelectedAIProvider: ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => void;
  allSttProviders: TYPE_PROVIDER[];
  customSttProviders: TYPE_PROVIDER[];
  selectedSttProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  onSetSelectedSttProvider: ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => void;
  screenshotConfiguration: ScreenshotConfig;
  setScreenshotConfiguration: React.Dispatch<
    React.SetStateAction<ScreenshotConfig>
  >;
  customizable: CustomizableState;
  toggleAppIconVisibility: (isVisible: boolean) => Promise<void>;
  toggleAlwaysOnTop: (isEnabled: boolean) => Promise<void>;
  toggleAutostart: (isEnabled: boolean) => Promise<void>;
  loadData: () => void;
  // input.id and output.id are two different id namespaces that happen to
  // share one shape: input.id is a MediaDevices deviceId (enumerated by the
  // webview, passed to getUserMedia), output.id is a native OS device id
  // (enumerated by the Rust speaker backend, never valid as a deviceId).
  // Don't pass one where the other is expected.
  selectedAudioDevices: {
    input: { id: string; name: string };
    output: { id: string; name: string };
  };
  setSelectedAudioDevices: Dispatch<
    SetStateAction<{
      input: { id: string; name: string };
      output: { id: string; name: string };
    }>
  >;
  setCursorType: (type: CursorType) => void;
  supportsImages: boolean;
  setSupportsImages: (value: boolean) => void;
};
