import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components";
import { AudioVisualizer } from "@/pages/app/components/speech/audio-visualizer";
import { fetchSTT } from "@/lib";
import { useApp } from "@/contexts";
import { StopCircle, Send } from "lucide-react";

interface AudioRecorderProps {
  onTranscriptionComplete: (text: string) => void;
  onCancel: () => void;
  // Optional: lets a parent surface the failure reason somewhere persistent
  // (e.g. a banner) instead of the message only living inside this component.
  onError?: (message: string) => void;
}

const MAX_DURATION = 3 * 60 * 1000;

// Probed in preference order. WKWebView's MediaRecorder only produces
// audio/mp4, not webm or ogg, so checking webm first (as Chromium-first code
// tends to) always falls through to ogg there and throws NotSupportedError.
const MIME_TYPE_CANDIDATES = ["audio/mp4", "audio/webm", "audio/ogg"] as const;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const AudioRecorder = ({
  onTranscriptionComplete,
  onCancel,
  onError,
}: AudioRecorderProps) => {
  const { selectedSttProvider, allSttProviders, selectedAudioDevices } =
    useApp();
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const maxDurationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Cleanup function - stops all tracks and clears refs
  const cleanup = useCallback(() => {
    // Clear timers
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (maxDurationTimeoutRef.current) {
      clearTimeout(maxDurationTimeoutRef.current);
      maxDurationTimeoutRef.current = null;
    }

    // Stop media recorder
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // Ignore errors when stopping
      }
    }
    mediaRecorderRef.current = null;

    // Stop all audio tracks - this is critical for releasing the microphone
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
      streamRef.current = null;
    }

    // Also stop from state
    if (audioStream) {
      audioStream.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
    }
    setAudioStream(null);
  }, [audioStream]);

  useEffect(() => {
    startRecording();

    // Cleanup on unmount
    return () => {
      cleanup();
    };
  }, []);

  const startRecording = async () => {
    try {
      setError(null);

      // selectedAudioDevices.input.id is a MediaDevices deviceId (see
      // types/context.type.ts). Pass it bare, not wrapped in `{ exact }`: a
      // stale id then makes the browser degrade to the default device
      // instead of throwing OverconstrainedError.
      const deviceId = selectedAudioDevices?.input?.id;

      const audioConstraints: MediaTrackConstraints =
        deviceId && deviceId !== "default" ? { deviceId } : {};

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      // Store in both ref and state
      streamRef.current = stream;
      setAudioStream(stream);

      const mimeType = MIME_TYPE_CANDIDATES.find((type) =>
        MediaRecorder.isTypeSupported(type)
      );

      if (!mimeType) {
        throw new Error(
          "This browser cannot record audio in a supported format."
        );
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      startTimeRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.start(100);

      durationIntervalRef.current = setInterval(() => {
        setDuration(Date.now() - startTimeRef.current);
      }, 100);

      maxDurationTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          handleSend();
        }
      }, MAX_DURATION);
    } catch (err) {
      const message = getErrorMessage(err);
      console.error("Failed to start recording:", err);
      cleanup();
      // Surface the reason instead of cancelling silently. The user can
      // dismiss with the Stop button once they've read it.
      setError(message);
      onError?.(message);
    }
  };

  const handleStop = () => {
    cleanup();
    onCancel();
  };

  const handleSend = async () => {
    if (!mediaRecorderRef.current || isTranscribing) return;

    setIsTranscribing(true);

    const mimeType = mediaRecorderRef.current.mimeType;
    const chunks = [...audioChunksRef.current];

    // Cleanup immediately after getting chunks
    cleanup();

    try {
      const audioBlob = new Blob(chunks, { type: mimeType });

      const provider = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider
      );

      const text = await fetchSTT({
        provider: provider,
        selectedProvider: selectedSttProvider,
        audio: audioBlob,
      });

      onTranscriptionComplete(text);
    } catch (err) {
      const message = getErrorMessage(err);
      console.error("Transcription failed:", err);
      setIsTranscribing(false);
      setError(message);

      // Only close automatically when the parent can actually show the
      // reason somewhere else; otherwise stay open with the inline message
      // above so the failure isn't silent.
      if (onError) {
        onError(message);
        onCancel();
      }
    }
  };

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="border bg-background rounded-lg overflow-hidden">
      <div className="h-12 relative bg-muted/20">
        {error ? (
          <div className="h-full flex items-center justify-center px-3 text-center text-xs text-red-500">
            {error}
          </div>
        ) : audioStream ? (
          <div className="h-full w-full pt-3">
            <AudioVisualizer stream={audioStream} isRecording={true} />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Initializing...
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-4 py-2.5 border-t bg-muted/5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 bg-red-500 rounded-full animate-pulse" />
          <span className="text-sm font-mono tabular-nums font-medium">
            {formatTime(duration)}
          </span>
          <span className="text-xs text-muted-foreground">/ 3:00</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            onClick={handleStop}
            disabled={isTranscribing}
            className="h-8 w-8"
            title="Stop recording"
          >
            <StopCircle className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            onClick={handleSend}
            disabled={isTranscribing || !!error}
            className="h-8 w-8"
            title={isTranscribing ? "Sending..." : "Send to AI"}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
