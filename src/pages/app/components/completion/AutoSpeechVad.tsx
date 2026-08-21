import { fetchSTT } from "@/lib";
import { UseCompletionReturn } from "@/types";
import { useMicVAD } from "@ricky0123/vad-react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { floatArrayToWav } from "@/lib/utils";

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  microphoneDeviceId?: string;
}

const AutoSpeechVADInternal = ({
  submit,
  setState,
  setEnableVAD,
  microphoneDeviceId,
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const { selectedSttProvider, allSttProviders } = useApp();
  const micStartAttemptedRef = useRef(false);

  const audioConstraints: MediaTrackConstraints =
    microphoneDeviceId && microphoneDeviceId !== "default"
      ? { deviceId: microphoneDeviceId }
      : {};

  const vad = useMicVAD({
    userSpeakingThreshold: 0.6,
    startOnLoad: false,
    baseAssetPath: "/vad/",
    onnxWASMBasePath: "/vad/",
    model: "legacy",
    additionalAudioConstraints: audioConstraints,
    onSpeechEnd: async (audio) => {
      try {
        // convert float32array to blob
        const audioBlob = floatArrayToWav(audio, 16000, "wav");

        let transcription: string;

        // Check if we have a configured speech provider
        if (!selectedSttProvider.provider) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig) {
          console.warn("Selected speech provider configuration not found");
          setState((prev: any) => ({
            ...prev,
            error:
              "Selected speech provider not found. Please reconfigure in settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        // Use the fetchSTT function for all providers
        transcription = await fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });

        if (transcription) {
          submit(transcription);
        }
      } catch (error) {
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  // Surface a broken VAD the same way a missing STT provider is surfaced
  // above, so a dead mic shows an error instead of just sitting idle.
  useEffect(() => {
    if (!vad.errored) return;
    const message = vad.errored;
    console.error("Voice activity detection failed:", message);
    setState((prev: any) => ({
      ...prev,
      error: message,
    }));
  }, [vad.errored, setState]);

  // macOS gates microphone access behind TCC, which getUserMedia does not
  // reliably prompt for by itself inside a WKWebView -- the same reason
  // screen recording is checked explicitly elsewhere. Confirm (and request)
  // access before ever calling vad.start(), so a missing permission surfaces
  // as an error instead of a mic that silently listens to nothing.
  useEffect(() => {
    if (vad.loading || vad.errored || micStartAttemptedRef.current) return;
    micStartAttemptedRef.current = true;

    const startIfPermitted = async () => {
      if (navigator.platform.toLowerCase().includes("mac")) {
        const { checkMicrophonePermission, requestMicrophonePermission } =
          await import("tauri-plugin-macos-permissions-api");

        const hasPermission = await checkMicrophonePermission();
        if (!hasPermission) {
          await requestMicrophonePermission();
          setState((prev: any) => ({
            ...prev,
            error:
              "Microphone permission required. Please enable it in System Settings > Privacy & Security > Microphone, then click the mic button again.",
          }));
          return;
        }
      }

      vad.start();
      setEnableVAD(true);
    };

    startIfPermitted();
  }, [vad.loading, vad.errored]);

  return (
    <>
      <Button
        size="icon"
        disabled={!!vad.errored}
        onClick={() => {
          if (vad.listening) {
            vad.pause();
            setEnableVAD(false);
          } else if (!vad.loading && !vad.errored) {
            vad.start();
            setEnableVAD(true);
          }
        }}
        className="cursor-pointer"
      >
        {vad.errored ? (
          <MicOffIcon className="h-4 w-4 text-red-500" />
        ) : vad.loading ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : isTranscribing ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-green-500" />
        ) : vad.userSpeaking ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.listening ? (
          <MicOffIcon className="h-4 w-4 animate-pulse" />
        ) : (
          <MicIcon className="h-4 w-4" />
        )}
      </Button>
    </>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};
