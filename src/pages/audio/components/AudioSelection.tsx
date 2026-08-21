import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Header,
  Button,
} from "@/components";
import { MicIcon, RefreshCwIcon, HeadphonesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/contexts";
import { STORAGE_KEYS } from "@/config/constants";
import { safeLocalStorage } from "@/lib/storage";
import { isMacOS } from "@/lib";
import { invoke } from "@tauri-apps/api/core";

type AudioDeviceOption = { id: string; name: string; is_default: boolean };

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
};

export const AudioSelection = () => {
  const { selectedAudioDevices, setSelectedAudioDevices } = useApp();

  // loadAudioDevices is (re)installed once on mount so it can be reused by the
  // devicechange listener; read the latest selection through a ref instead of
  // closing over the state directly, otherwise the listener would keep
  // validating against the selection that existed at mount time.
  const selectedAudioDevicesRef = useRef(selectedAudioDevices);
  useEffect(() => {
    selectedAudioDevicesRef.current = selectedAudioDevices;
  }, [selectedAudioDevices]);

  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [showSuccess, setShowSuccess] = useState<{
    input: boolean;
    output: boolean;
  }>({
    input: false,
    output: false,
  });
  const [devices, setDevices] = useState<{
    input: AudioDeviceOption[];
    output: AudioDeviceOption[];
  }>({
    input: [],
    output: [],
  });
  const [inputError, setInputError] = useState<string | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);

  // Save devices to localStorage
  const saveToStorage = (newDevices: typeof selectedAudioDevices) => {
    safeLocalStorage.setItem(
      STORAGE_KEYS.SELECTED_AUDIO_DEVICES,
      JSON.stringify(newDevices)
    );
  };

  // Microphones are enumerated by the webview instead of the OS layer, so the
  // id handed back is always one getUserMedia understands. Permission is
  // gated on macOS only, mirroring the screen-recording flow in
  // speech/index.tsx: check, request, and let the user retry once granted.
  const loadInputDevices = async (): Promise<AudioDeviceOption[]> => {
    if (isMacOS()) {
      const { checkMicrophonePermission, requestMicrophonePermission } =
        await import("tauri-plugin-macos-permissions-api");

      const hasPermission = await checkMicrophonePermission();
      if (!hasPermission) {
        await requestMicrophonePermission();
        throw new Error(
          "Microphone access was just requested. Grant it, then click refresh."
        );
      }
    }

    // Device labels stay blank until a getUserMedia grant exists for this
    // session; take a throwaway stream just to unlock them, then release it.
    const warmupStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    warmupStream.getTracks().forEach((track) => track.stop());

    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const inputs = allDevices.filter((d) => d.kind === "audioinput");
    const hasDefaultEntry = inputs.some((d) => d.deviceId === "default");

    return inputs.map((d, index) => ({
      id: d.deviceId,
      name: d.label || `Microphone ${index + 1}`,
      is_default: hasDefaultEntry ? d.deviceId === "default" : index === 0,
    }));
  };

  const loadOutputDevices = async (): Promise<AudioDeviceOption[]> => {
    const outputDevices = await invoke<AudioDeviceOption[]>(
      "get_output_devices"
    );
    return outputDevices.map((output) => ({
      id: output?.id,
      name: output?.name,
      is_default: output?.is_default,
    }));
  };

  // Load all audio devices (input and output)
  const loadAudioDevices = async () => {
    setIsLoadingDevices(true);
    setInputError(null);
    setOutputError(null);

    const [inputResult, outputResult] = await Promise.allSettled([
      loadInputDevices(),
      loadOutputDevices(),
    ]);

    const inputDevices =
      inputResult.status === "fulfilled" ? inputResult.value : [];
    const outputDevices =
      outputResult.status === "fulfilled" ? outputResult.value : [];

    if (inputResult.status === "rejected") {
      setInputError(getErrorMessage(inputResult.reason));
    }
    if (outputResult.status === "rejected") {
      setOutputError(getErrorMessage(outputResult.reason));
    }

    setDevices({ input: inputDevices, output: outputDevices });

    // Only update if no device is currently selected or if the selected device doesn't exist
    const selected = selectedAudioDevicesRef.current;
    const currentInputExists = inputDevices.some(
      (d) => d.id === selected.input.id
    );
    const currentOutputExists = outputDevices.some(
      (d) => d.id === selected.output.id
    );

    // Only reconcile a slot when its fetched list actually has entries. An
    // empty list means the fetch failed or permission isn't granted yet, not
    // that the device disappeared, so it must never stomp a saved selection
    // with "" over that.
    const shouldReconcileInput =
      inputDevices.length > 0 && !currentInputExists;
    const shouldReconcileOutput =
      outputDevices.length > 0 && !currentOutputExists;

    if (shouldReconcileInput || shouldReconcileOutput) {
      const defaultInput = inputDevices.find((d) => d.is_default);
      const defaultOutput = outputDevices.find((d) => d.is_default);

      const newDevices = {
        input: shouldReconcileInput
          ? {
              id: defaultInput?.id || inputDevices[0]?.id || "",
              name: defaultInput?.name || inputDevices[0]?.name || "",
            }
          : selected.input,
        output: shouldReconcileOutput
          ? {
              id: defaultOutput?.id || outputDevices[0]?.id || "",
              name: defaultOutput?.name || outputDevices[0]?.name || "",
            }
          : selected.output,
      };

      setSelectedAudioDevices(newDevices);
      saveToStorage(newDevices);
    }

    setIsLoadingDevices(false);
  };

  useEffect(() => {
    loadAudioDevices();

    // Plugging in or removing a device (e.g. a headset) refreshes the list
    // without the user needing to press the refresh button.
    const handleMediaDevicesChange = () => {
      loadAudioDevices();
    };

    navigator.mediaDevices.addEventListener(
      "devicechange",
      handleMediaDevicesChange
    );

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleMediaDevicesChange
      );
    };
  }, []);

  // Handle device selection changes
  const handleDeviceChange = (type: "input" | "output", deviceId: string) => {
    const deviceList = type === "input" ? devices.input : devices.output;
    const selectedDevice = deviceList.find((d) => d.id === deviceId);

    if (!selectedDevice) return;

    const newDevices = {
      ...selectedAudioDevices,
      [type]: { id: deviceId, name: selectedDevice.name },
    };

    setSelectedAudioDevices(newDevices);
    saveToStorage(newDevices);

    setShowSuccess((prev) => ({ ...prev, [type]: true }));
    setTimeout(() => {
      setShowSuccess((prev) => ({ ...prev, [type]: false }));
    }, 3000);
  };

  // Looked up once so the trigger label never falls into "value + string"
  // concatenation, where a missing match (undefined) would stringify to the
  // literal text "undefined" instead of falling back.
  const selectedInputDevice = devices.input.find(
    (mic) => mic.id === selectedAudioDevices.input.id
  );
  const selectedOutputDevice = devices.output.find(
    (output) => output.id === selectedAudioDevices.output.id
  );
  const outputLoadFailed = outputError !== null;

  return (
    <div id="audio" className="space-y-1 flex flex-col gap-4">
      {/* Microphone Input Section */}
      <div className="space-y-3">
        <Header
          title="Microphone"
          description="Select your microphone for voice input and speech-to-text. If issues occur, adjust your system's default microphone in OS settings."
        />

        <div className="space-y-3">
          {/* Microphone Selection Dropdown */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Select
                value={selectedAudioDevices.input.id}
                onValueChange={(value) => handleDeviceChange("input", value)}
                disabled={isLoadingDevices || devices.input.length === 0}
              >
                <SelectTrigger className="w-full h-11 border-1 border-input/50 focus:border-primary/50 transition-colors">
                  <div className="flex items-center gap-2">
                    <MicIcon className="size-4" />
                    <div className="text-sm font-medium truncate">
                      {isLoadingDevices
                        ? "Loading microphones..."
                        : devices.input.length === 0
                        ? "No microphones found"
                        : selectedInputDevice
                        ? `${selectedInputDevice.name}${
                            selectedInputDevice.is_default ? " (Default)" : ""
                          }`
                        : "Select a microphone"}
                    </div>
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {devices.input.map((mic) => (
                    <SelectItem key={mic.id} value={mic.id}>
                      <div className="flex items-center gap-2">
                        <MicIcon className="size-4" />
                        <div className="font-medium truncate">{mic.name} </div>
                        {mic.is_default && " (Default)"}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Refresh button */}
              <Button
                size="icon"
                variant="outline"
                onClick={loadAudioDevices}
                disabled={isLoadingDevices}
                className="h-11 w-11 shrink-0"
                title="Refresh microphone list"
              >
                <RefreshCwIcon
                  className={`size-4 ${isLoadingDevices ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </div>

          {/* Success message */}
          {showSuccess.input && (
            <div className="text-xs text-green-500 bg-green-500/10 p-3 rounded-md">
              <strong>✓ Microphone changed successfully!</strong>
              <br />
              Using: {selectedAudioDevices.input.name || "Unknown device"}
            </div>
          )}

          {/* Failure / empty state */}
          {!isLoadingDevices && devices.input.length === 0 && (
            <div className="text-xs text-amber-500 bg-amber-500/10 p-3 rounded-md">
              <strong>⚠️ {inputError || "No microphones found."}</strong>{" "}
              Click the refresh button to try again, or check your microphone
              and privacy settings.
            </div>
          )}
        </div>

        {/* Tips */}
        <div className="text-xs text-muted-foreground/70">
          <p>
            💡 <strong>Tip:</strong> When you select a microphone, the app will
            immediately switch to that device. You can verify by hovering over
            the microphone button in the main interface - it will show the
            active device name.
          </p>
        </div>
      </div>

      {/* System Audio Output Section */}
      <div className="space-y-3">
        <Header
          title="System Audio"
          description="Select the output device to capture system sounds and application audio. If issues occur, set the correct default output in OS settings."
        />

        <div className="space-y-3">
          {outputLoadFailed ? (
            <div className="text-xs text-amber-500 bg-amber-500/10 p-3 rounded-md">
              {isMacOS() ? (
                "System audio capture isn't available in this build on macOS. Microphone input works normally."
              ) : (
                <>
                  <strong>⚠️ Couldn't load output devices.</strong>{" "}
                  {outputError}
                </>
              )}
            </div>
          ) : (
            <>
              {/* Output Selection Dropdown */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedAudioDevices.output.id}
                    onValueChange={(value) =>
                      handleDeviceChange("output", value)
                    }
                    disabled={isLoadingDevices || devices.output.length === 0}
                  >
                    <SelectTrigger className="w-full h-11 border-1 border-input/50 focus:border-primary/50 transition-colors">
                      <div className="flex items-center gap-2">
                        <HeadphonesIcon className="size-4" />
                        <div className="text-sm font-medium truncate">
                          {isLoadingDevices
                            ? "Loading output devices..."
                            : devices.output.length === 0
                            ? "No output devices found"
                            : selectedOutputDevice
                            ? `${selectedOutputDevice.name}${
                                selectedOutputDevice.is_default
                                  ? " (Default)"
                                  : ""
                              }`
                            : "Select an output device"}
                        </div>
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {devices.output.map((output) => (
                        <SelectItem key={output.id} value={output.id}>
                          <div className="flex items-center gap-2">
                            <HeadphonesIcon className="size-4" />
                            <div className="font-medium truncate">
                              {output.name} {output.is_default && " (Default)"}
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Refresh button */}
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={loadAudioDevices}
                    disabled={isLoadingDevices}
                    className="h-11 w-11 shrink-0"
                    title="Refresh output device list"
                  >
                    <RefreshCwIcon
                      className={`size-4 ${
                        isLoadingDevices ? "animate-spin" : ""
                      }`}
                    />
                  </Button>
                </div>
              </div>

              {/* Success message */}
              {showSuccess.output && (
                <div className="text-xs text-green-500 bg-green-500/10 p-3 rounded-md">
                  <strong>✓ Output device changed successfully!</strong>
                  <br />
                  Using: {selectedAudioDevices.output.name || "Unknown device"}
                </div>
              )}

              {/* Empty state */}
              {devices.output.length === 0 && !isLoadingDevices && (
                <div className="text-xs text-amber-500 bg-amber-500/10 p-3 rounded-md">
                  <strong>⚠️ No output devices found.</strong> Click the
                  refresh button to try again, or verify your system audio
                  output in system settings.
                </div>
              )}
            </>
          )}
        </div>

        {/* Tips */}
        <div className="text-xs text-muted-foreground/70">
          <p>
            💡 <strong>Tip:</strong> System audio capture allows you to record
            audio playing through your speakers or headphones. This is useful
            for capturing conversation audio or system sounds along with your
            voice.
          </p>
        </div>
      </div>
    </div>
  );
};
