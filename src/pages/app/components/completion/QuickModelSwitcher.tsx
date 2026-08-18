import { useState, useEffect } from "react";
import { useApp } from "@/contexts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components";
import { Cpu, Check, Sparkles, HardDrive, Wifi } from "lucide-react";

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  claude: "Anthropic Claude",
  grok: "xAI Grok",
  gemini: "Google Gemini",
  mistral: "Mistral AI",
  deepseek: "DeepSeek",
  groq: "Groq",
  ollama: "Local Ollama",
  openrouter: "OpenRouter",
};

export const QuickModelSwitcher = () => {
  const {
    selectedAIProvider,
    onSetSelectedAIProvider,
    allAiProviders,
  } = useApp();
  const [isOpen, setIsOpen] = useState(false);
  const [ollamaOnline, setOllamaOnline] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  useEffect(() => {
    if (!isOpen) return;

    // Check Ollama status and list models
    const checkOllama = async () => {
      try {
        const res = await fetch("http://localhost:11434/api/tags", {
          signal: AbortSignal.timeout(1200),
        });
        if (res.ok) {
          const data = await res.json();
          const models = (data.models || []).map((m: any) => m.name || m.model);
          setOllamaModels(models);
          setOllamaOnline(true);
        } else {
          setOllamaOnline(false);
        }
      } catch {
        setOllamaOnline(false);
        setOllamaModels([]);
      }
    };

    checkOllama();
  }, [isOpen]);

  const activeProviderId = selectedAIProvider.provider || "gemini";
  const activeModel =
    selectedAIProvider.variables?.model ||
    PROVIDER_NAMES[activeProviderId] ||
    activeProviderId;

  const displayName = activeModel
    .replace(/^gemini-/, "Gemini ")
    .replace(/^gpt-/, "GPT-")
    .replace(/^claude-/, "Claude ");

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch AI Engine"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-muted/40 hover:bg-primary/15 border border-white/10 hover:border-primary/40 text-muted-foreground hover:text-foreground transition-all cursor-pointer select-none"
        >
          <Sparkles className="size-3 text-cyan-400 animate-pulse" />
          <span className="max-w-[100px] truncate text-[11px] font-semibold text-foreground/90">
            {displayName}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-56 p-1.5 rounded-xl border border-white/10 shadow-2xl bg-popover/95 backdrop-blur-2xl animate-in fade-in zoom-in-95 duration-150 z-50"
      >
        {/* Header */}
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex items-center justify-between border-b border-border/40 mb-1">
          <div className="flex items-center gap-1.5">
            <Cpu className="size-3 text-primary" />
            <span>AI Engines</span>
          </div>
          {ollamaOnline && (
            <span className="flex items-center gap-1 text-[9px] text-emerald-400 font-medium">
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Ollama Live
            </span>
          )}
        </div>

        <div className="flex flex-col gap-0.5 max-h-60 overflow-y-auto">
          {/* Local Ollama detected models */}
          {ollamaOnline && ollamaModels.length > 0 && (
            <div className="mb-1">
              <div className="px-2 py-0.5 text-[9px] font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-1">
                <HardDrive className="size-2.5" />
                <span>Offline Local</span>
              </div>
              {ollamaModels.map((model) => {
                const isSelected =
                  selectedAIProvider.provider === "ollama" &&
                  selectedAIProvider.variables?.model === model;
                return (
                  <button
                    key={`ollama-${model}`}
                    type="button"
                    onClick={() => {
                      onSetSelectedAIProvider({
                        provider: "ollama",
                        variables: {
                          ...selectedAIProvider.variables,
                          model,
                        },
                      });
                      setIsOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer text-left ${
                      isSelected
                        ? "bg-emerald-500/20 text-emerald-300 font-medium border border-emerald-500/30"
                        : "hover:bg-muted/50 text-foreground/80 hover:text-foreground"
                    }`}
                  >
                    <div className="flex flex-col truncate pr-2">
                      <span className="truncate">{model}</span>
                      <span className="text-[9px] text-emerald-400/80">
                        100% Local / Zero Cloud
                      </span>
                    </div>
                    {isSelected && (
                      <Check className="size-3 text-emerald-400 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Cloud API Providers */}
          <div className="px-2 py-0.5 text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1">
            <Wifi className="size-2.5" />
            <span>Cloud Providers</span>
          </div>

          {allAiProviders.map((provider) => {
            const providerId = provider.id || "custom";
            if (providerId === "ollama" && ollamaOnline && ollamaModels.length > 0) {
              return null; // Shown under local models
            }
            const isSelected = selectedAIProvider.provider === providerId;
            const name = PROVIDER_NAMES[providerId] || providerId;

            return (
              <button
                key={providerId}
                type="button"
                onClick={() => {
                  onSetSelectedAIProvider({
                    provider: providerId,
                    variables: selectedAIProvider.variables || {},
                  });
                  setIsOpen(false);
                }}
                className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer text-left ${
                  isSelected
                    ? "bg-primary/20 text-primary font-medium border border-primary/30"
                    : "hover:bg-muted/50 text-foreground/80 hover:text-foreground"
                }`}
              >
                <div className="flex flex-col truncate pr-2">
                  <span className="truncate">{name}</span>
                  <span className="text-[9px] text-muted-foreground/70 truncate">
                    {providerId === "ollama" ? "Local Offline" : "Cloud API"}
                  </span>
                </div>
                {isSelected && <Check className="size-3 text-primary shrink-0" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};
