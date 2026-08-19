import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/contexts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Input,
} from "@/components";
import {
  Cpu,
  Check,
  Sparkles,
  HardDrive,
  Wifi,
  RefreshCw,
  Search,
} from "lucide-react";
import { listModels, readCachedModels, writeCachedModels } from "@/lib";

/** Above this many models the list needs a filter to be usable. */
const FILTER_THRESHOLD = 8;

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
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [filter, setFilter] = useState("");

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
  const activeProvider = allAiProviders.find((p) => p.id === activeProviderId);

  const loadModels = useCallback(
    async (options: { refresh?: boolean } = {}) => {
      if (activeProviderId === "ollama") return;

      if (!options.refresh) {
        const cached = readCachedModels(activeProviderId);
        if (cached) {
          setModels(cached);
          setModelsError(null);
          return;
        }
      }

      setIsLoadingModels(true);
      setModelsError(null);
      try {
        const fetched = await listModels({
          providerId: activeProviderId,
          variables: selectedAIProvider.variables ?? {},
          curl: activeProvider?.curl,
        });
        setModels(fetched);
        writeCachedModels(activeProviderId, fetched);
      } catch (error) {
        setModels([]);
        setModelsError(
          error instanceof Error ? error.message : "Could not list models"
        );
      } finally {
        setIsLoadingModels(false);
      }
    },
    [activeProviderId, activeProvider?.curl, selectedAIProvider.variables]
  );

  useEffect(() => {
    if (!isOpen) return;
    loadModels();
  }, [isOpen, loadModels]);

  const selectModel = (model: string) => {
    // Same provider, same key: only the model changes.
    onSetSelectedAIProvider({
      provider: activeProviderId,
      variables: { ...(selectedAIProvider.variables ?? {}), model },
    });
    setIsOpen(false);
  };

  const visibleModels = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) => model.toLowerCase().includes(needle));
  }, [models, filter]);

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
          data-slot="model-switcher"
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
        // The window is 54px tall until it grows for this popover, so collision
        // detection would measure a viewport that is about to change and flip the
        // panel up off the top of the screen.
        avoidCollisions={false}
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

        {/* Models available for the key already configured on this provider */}
        {activeProviderId !== "ollama" && (
          <div className="mb-1">
            <div className="px-2 py-0.5 flex items-center justify-between">
              <span className="text-[9px] font-semibold text-primary uppercase tracking-wider">
                {PROVIDER_NAMES[activeProviderId] || activeProviderId} models
              </span>
              <button
                type="button"
                onClick={() => loadModels({ refresh: true })}
                title="Refresh model list"
                className="cursor-pointer text-muted-foreground/70 hover:text-foreground transition"
              >
                <RefreshCw
                  className={`size-2.5 ${isLoadingModels ? "animate-spin" : ""}`}
                />
              </button>
            </div>

            {models.length > FILTER_THRESHOLD && (
              <div className="relative px-1 pb-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/60" />
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={`Filter ${models.length} models`}
                  className="h-7 pl-7 text-[11px] rounded-lg"
                />
              </div>
            )}

            {isLoadingModels && models.length === 0 && (
              <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">
                Loading models...
              </div>
            )}

            {modelsError && (
              <div className="px-2.5 py-1.5 text-[10px] text-destructive">
                {modelsError}
              </div>
            )}

            <div className="flex flex-col gap-0.5 max-h-44 overflow-y-auto">
              {visibleModels.map((model) => {
                const isSelected = selectedAIProvider.variables?.model === model;
                return (
                  <button
                    key={`model-${model}`}
                    type="button"
                    data-slot="model-option"
                    onClick={() => selectModel(model)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer text-left ${
                      isSelected
                        ? "bg-primary/20 text-primary font-medium border border-primary/30"
                        : "hover:bg-muted/50 text-foreground/80 hover:text-foreground"
                    }`}
                  >
                    <span className="truncate pr-2">{model}</span>
                    {isSelected && (
                      <Check className="size-3 text-primary shrink-0" />
                    )}
                  </button>
                );
              })}
              {!isLoadingModels &&
                !modelsError &&
                models.length > 0 &&
                visibleModels.length === 0 && (
                  <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">
                    No model matches "{filter}".
                  </div>
                )}
            </div>
          </div>
        )}

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
