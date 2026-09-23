import {
  Card,
  CustomCursor,
} from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
} from "./components";
import { useApp, useHudAutoHeight } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const { customizable } = useAppContext();
  const platform = getPlatform();
  const hudRef = useRef<HTMLDivElement>(null);

  useHudAutoHeight(hudRef);

  // Zero-mouse hands-free HUD dismiss via Escape key
  useEffect(() => {
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        // If a popover or dialog is open, let Radix handle dismissal
        const openOverlay = document.querySelector(
          '[data-state="open"]:not([data-slot="card"])'
        );
        if (openOverlay) return;

        try {
          await invoke("hide_hud");
        } catch {}
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
        <Card ref={hudRef} className="w-full flex flex-row items-center gap-1.5 p-1.5 rounded-xl bg-card/90 backdrop-blur-xl border border-white/10 shadow-lg transition-all duration-200 opacity-95 hover:opacity-100 focus-within:opacity-100" data-tauri-drag-region>
          <SystemAudio {...systemAudio} />
          {systemAudio?.capturing ? (
            <div className="flex flex-row items-center gap-2 justify-between w-full">
              <div className="flex flex-1 items-center gap-2">
                <AudioVisualizer isRecording={systemAudio?.capturing} />
              </div>
              <div className="flex !w-fit items-center gap-2">
                <StatusIndicator
                  setupRequired={systemAudio.setupRequired}
                  error={systemAudio.error}
                  isProcessing={systemAudio.isProcessing}
                  isAIProcessing={systemAudio.isAIProcessing}
                  capturing={systemAudio.capturing}
                />
              </div>
            </div>
          ) : null}

          <div
            className={`${
              systemAudio?.capturing
                ? "hidden w-full fade-out transition-all duration-300"
                : "w-full flex flex-row gap-1.5 items-center"
            }`}
          >
            <Completion isHidden={isHidden} />
            <div
              data-slot="hud-keybinds"
              className="flex items-center gap-2.5 px-2.5 py-1 text-[11px] font-medium text-muted-foreground/80 select-none shrink-0 border-l border-white/10"
            >
              <div className="flex items-center gap-1.5" title="Double tap Right Shift to snap screen and solve">
                <kbd className="px-1.5 py-0.5 rounded bg-muted/60 border border-white/10 text-[10px] font-mono text-cyan-400 font-semibold shadow-xs">⇧⇧</kbd>
                <span>Snap & Solve</span>
              </div>
              <div className="flex items-center gap-1.5" title="Press Alt + C to copy solution/answer to clipboard">
                <kbd className="px-1.5 py-0.5 rounded bg-muted/60 border border-white/10 text-[10px] font-mono text-indigo-400 font-semibold shadow-xs">⌥C</kbd>
                <span>Copy</span>
              </div>
              <div className="flex items-center gap-1.5" title="Press Alt + T to simulate human typing into active window">
                <kbd className="px-1.5 py-0.5 rounded bg-muted/60 border border-white/10 text-[10px] font-mono text-emerald-400 font-semibold shadow-xs">⌥T</kbd>
                <span>Auto-Type</span>
              </div>
              <div className="flex items-center gap-1.5" title="Press Alt + R to run local test suite on code solution">
                <kbd className="px-1.5 py-0.5 rounded bg-muted/60 border border-white/10 text-[10px] font-mono text-amber-400 font-semibold shadow-xs">⌥R</kbd>
                <span>Run Tests</span>
              </div>
              <div className="flex items-center gap-1.5" title="Press Escape to hide or cancel">
                <kbd className="px-1.5 py-0.5 rounded bg-muted/60 border border-white/10 text-[10px] font-mono text-muted-foreground font-semibold shadow-xs">Esc</kbd>
                <span>Hide</span>
              </div>
            </div>
          </div>
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
