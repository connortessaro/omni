import { useState, useEffect, useCallback } from "react";
import { Loader2, XIcon, Clipboard, FileCode2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  ScrollArea,
  Textarea,
  Markdown,
  Switch,
  CopyButton,
} from "@/components";
import { UseCompletionReturn } from "@/types";
import { MessageHistory } from "./MessageHistory";
import {
  playHapticClick,
  playActionChime,
  createPasteBlock,
  formatTokenCount,
  PASTE_AS_BLOCK_THRESHOLD,
} from "@/lib";

/** Big enough for a real diff, small enough that reading it never stalls the HUD. */
const CLIPBOARD_PEEK_LIMIT = 100_000;

/** Must fit one line in the narrow HUD, or a textarea wraps and clips it. */
const PROMPT_PLACEHOLDER = "Ask anything or type /";

/** One line of the prompt box, matching the icon buttons beside it. */
const PROMPT_MIN_HEIGHT = 36;
const PROMPT_MAX_HEIGHT = 320;


const SLASH_COMMANDS = [
  { command: "/fix", description: "Fix grammar & tone", example: "/fix <text>" },
  { command: "/commit", description: "Generate git commit message", example: "/commit [diff]" },
  { command: "/refactor", description: "Refactor code for performance", example: "/refactor <code>" },
  { command: "/explain", description: "Explain concept simply", example: "/explain <topic>" },
  { command: "/code", description: "Generate production code", example: "/code <prompt>" },
  { command: "/summarize", description: "Summarize bullet points", example: "/summarize <text>" },
  { command: "/translate", description: "Translate to English / target", example: "/translate <text>" },
  { command: "/regex", description: "Explain or build regex", example: "/regex <pattern>" },
  { command: "/clear", description: "Clear conversation", example: "/clear" },
];

export const Input = ({
  isPopoverOpen,
  isLoading,
  reset,
  input,
  setInput,
  handleKeyPress,
  handlePaste,
  currentConversationId,
  conversationHistory,
  startNewConversation,
  messageHistoryOpen,
  setMessageHistoryOpen,
  error,
  response,
  cancel,
  scrollAreaRef,
  inputRef,
  isHidden,
  keepEngaged,
  setKeepEngaged,
  contextBlocks,
  addContextBlock,
  removeContextBlock,
  historyNotice,
}: UseCompletionReturn & { isHidden: boolean }) => {
  const [clipboardSnippet, setClipboardSnippet] = useState<string | null>(null);

  // WKWebView does not honor `field-sizing: content`, so grow the box here.
  const growToFitContent = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = `${PROMPT_MIN_HEIGHT}px`;
    if (!element.value) return;
    if (element.scrollHeight <= element.clientHeight) return;
    element.style.height = `${Math.min(
      element.scrollHeight,
      PROMPT_MAX_HEIGHT
    )}px`;
  }, []);

  useEffect(() => {
    growToFitContent(inputRef.current);
  }, [input, growToFitContent, inputRef]);

  useEffect(() => {
    if (isPopoverOpen || input || isLoading || isHidden) {
      setClipboardSnippet(null);
      return;
    }

    const checkClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (
          text &&
          text.trim().length >= 4 &&
          text.trim().length <= CLIPBOARD_PEEK_LIMIT
        ) {
          setClipboardSnippet(text.trim());
        } else {
          setClipboardSnippet(null);
        }
      } catch {
        setClipboardSnippet(null);
      }
    };

    checkClipboard();
  }, [isPopoverOpen, input, isLoading, isHidden]);

  return (
    <div className="relative flex-1">
      <Popover
        open={isPopoverOpen}
        onOpenChange={(open) => {
          if (!open && !isLoading && !keepEngaged) {
            reset();
          }
        }}
      >
        <PopoverTrigger asChild className="!border-none !bg-transparent">
          <div className="relative">
            {contextBlocks.length > 0 && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1">
                {contextBlocks.map((block) => (
                  <span
                    key={block.id}
                    data-slot="context-chip"
                    className="inline-flex items-center gap-1.5 rounded-md border border-input/40 bg-muted/60 px-2 py-0.5 text-[10px] font-medium"
                  >
                    {block.kind === "paste" ? (
                      <Clipboard className="size-3 shrink-0 text-cyan-400" />
                    ) : (
                      <FileCode2 className="size-3 shrink-0 text-cyan-400" />
                    )}
                    <span className="max-w-[150px] truncate">{block.label}</span>
                    <span className="font-mono text-muted-foreground/70">
                      {formatTokenCount(block.approxTokens)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeContextBlock(block.id)}
                      title={`Remove ${block.label} from context`}
                      className="cursor-pointer rounded text-muted-foreground/70 transition hover:text-destructive"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="relative">
              <Textarea
                ref={inputRef}
                rows={1}
                placeholder={PROMPT_PLACEHOLDER}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) playHapticClick();
                  handleKeyPress(e);
                }}
                onPaste={handlePaste}
                disabled={isLoading || isHidden}
                className={`h-9 min-h-9 resize-none overflow-y-auto border-primary/50 py-1 leading-snug focus-visible:border-ring/60 focus-visible:ring-ring dark:border-input/80 dark:focus-visible:ring-ring/60 ${
                  currentConversationId && conversationHistory.length > 0
                    ? "pr-14"
                    : "pr-2"
                }`}
              />

            {/* Smart Clipboard Inline AI Actions */}
            {clipboardSnippet && !input && !isPopoverOpen && !isLoading && (
              <div className="absolute left-0 right-0 top-full mt-2 flex items-center justify-between px-3 py-1.5 rounded-xl bg-card/95 backdrop-blur-2xl border border-white/10 shadow-xl text-xs animate-in fade-in slide-in-from-top-1 duration-150 z-40">
                <div className="flex items-center gap-1.5 text-muted-foreground truncate max-w-[160px]">
                  <Clipboard className="size-3 text-cyan-400 shrink-0" />
                  <span className="truncate text-[11px] font-mono opacity-80">"{clipboardSnippet.slice(0, 24)}..."</span>
                </div>
                <div className="flex items-center gap-1">
                  {[
                    { label: "⚡ Fix", prefix: "/fix " },
                    { label: "🚀 Commit", prefix: "/commit " },
                    { label: "💻 Refactor", prefix: "/refactor " },
                    { label: "🔍 Explain", prefix: "/explain " },
                  ].map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => {
                        playActionChime();
                        if (clipboardSnippet.length > PASTE_AS_BLOCK_THRESHOLD) {
                          addContextBlock(createPasteBlock(clipboardSnippet));
                          setInput(action.prefix.trim());
                        } else {
                          setInput(`${action.prefix}${clipboardSnippet}`);
                        }
                        setTimeout(() => {
                          inputRef.current?.focus();
                        }, 50);
                      }}
                      className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-muted/60 hover:bg-primary/20 hover:text-primary hover:border-primary/40 border border-input/40 transition cursor-pointer select-none"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Slash command autocomplete */}
            {input.startsWith("/") && !isPopoverOpen && !isLoading && (
              <div className="absolute left-0 right-0 top-full mt-2 bg-popover/95 backdrop-blur-md border border-input/60 rounded-xl shadow-xl p-1.5 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
                <div className="text-[10px] text-muted-foreground/70 px-2 py-1 font-semibold uppercase tracking-wider">
                  Slash Commands
                </div>
                <div className="flex flex-col gap-0.5">
                  {SLASH_COMMANDS.filter((cmd) =>
                    cmd.command.startsWith(input.split(" ")[0].toLowerCase())
                  ).map((cmd) => (
                    <button
                      key={cmd.command}
                      type="button"
                      onClick={() => {
                        setInput(cmd.command + (cmd.command === "/clear" ? "" : " "));
                        inputRef.current?.focus();
                      }}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-xs hover:bg-primary/10 hover:text-primary transition cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-primary">
                          {cmd.command}
                        </span>
                        <span className="text-muted-foreground">
                          {cmd.description}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground/60">
                        {cmd.example}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

              {/* Conversation thread indicator */}
              {currentConversationId &&
                conversationHistory.length > 0 &&
                !isLoading && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <MessageHistory
                      conversationHistory={conversationHistory}
                      currentConversationId={currentConversationId}
                      onStartNewConversation={startNewConversation}
                      messageHistoryOpen={messageHistoryOpen}
                      setMessageHistoryOpen={setMessageHistoryOpen}
                    />
                  </div>
                )}

              {/* Loading indicator */}
              {isLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 animate-pulse">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>
        </PopoverTrigger>

        {/* Response Panel */}
        <PopoverContent
          align="end"
          side="bottom"
          className="w-screen p-0 border border-white/10 shadow-2xl overflow-hidden rounded-2xl bg-popover/90 backdrop-blur-2xl"
          sideOffset={8}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50 bg-muted/20">
            <div className="flex flex-row gap-2 items-center">
              <span className="flex size-2 rounded-full bg-emerald-400 animate-pulse" />
              <h3 className="font-semibold text-xs text-foreground/90">
                {keepEngaged ? "Continuous Conversation" : "Omni Assistant"}
              </h3>
              <span className="text-[10px] text-muted-foreground/60 hidden sm:inline">
                (↑/↓ to scroll)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex flex-row items-center gap-1.5 mr-2">
                <span className="text-[10px] text-muted-foreground">{`Conversation`}</span>
                <span className="text-[10px] text-muted-foreground/70 bg-muted/40 px-1.5 py-0.5 rounded-md border border-input/40 font-mono">
                  {navigator.platform.toLowerCase().includes("mac")
                    ? "⌘"
                    : "Ctrl"}{" "}
                  K
                </span>
                <Switch
                  checked={keepEngaged}
                  onCheckedChange={(checked) => {
                    setKeepEngaged(checked);
                    setTimeout(() => {
                      inputRef?.current?.focus();
                    }, 100);
                  }}
                />
              </div>
              <CopyButton content={response} />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  if (isLoading) {
                    cancel();
                  } else if (keepEngaged) {
                    setKeepEngaged(false);
                    startNewConversation();
                  } else {
                    reset();
                  }
                }}
                className="cursor-pointer hover:bg-destructive/10 hover:text-destructive size-7 transition-colors rounded-lg"
                title={
                  isLoading
                    ? "Cancel loading"
                    : keepEngaged
                    ? "Close and start new conversation"
                    : "Clear conversation (Esc)"
                }
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </div>

          <ScrollArea ref={scrollAreaRef} className="h-[calc(100vh-7rem)]">
            <div className="p-4">
              {error && (
                <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
                  <strong>Error:</strong> {error}
                </div>
              )}
              {historyNotice && (
                <div
                  data-slot="history-notice"
                  className="mb-3 rounded-lg border border-input/40 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                >
                  {historyNotice}
                </div>
              )}
              {isLoading && (
                <div className="flex items-center gap-2 my-4 text-muted-foreground animate-pulse select-none">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Generating response...</span>
                </div>
              )}
              {response && (
                <div>
                  <Markdown>{response}</Markdown>
                  {!isLoading && (
                    <div className="flex flex-col gap-2 pt-3 border-t border-border/40 mt-3">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            "⚡ Caveman",
                            "✨ Summarize",
                            "🔍 Explain simpler",
                            "💻 Show code",
                            "🐛 Fix bugs",
                            "📝 Action items",
                          ].map((pill) => (
                            <button
                              key={pill}
                              type="button"
                              onClick={() => {
                                playHapticClick();
                                const cleanPrompt = pill.replace(/^[^\w\s]+\s*/, "");
                                setInput(cleanPrompt === "Caveman" ? "Rewrite in caveman ultra mode (max compression, zero fluff)" : cleanPrompt);
                                setTimeout(() => {
                                  inputRef.current?.focus();
                                }, 50);
                              }}
                              className="text-[11px] px-2.5 py-1 rounded-full bg-muted/60 hover:bg-primary/10 hover:text-primary hover:border-primary/30 border border-input/40 transition cursor-pointer font-medium select-none"
                            >
                              {pill}
                            </button>
                          ))}
                        </div>
                        <span className="text-[10px] text-muted-foreground/60 font-mono">
                          ~{Math.round(response.split(/\s+/).length * 1.3)} tokens · {response.split(/\s+/).length} words
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Conversation History - Separate scroll, no auto-scroll */}
              {keepEngaged && conversationHistory.length > 1 && (
                <div className="space-y-3 pt-3">
                  {conversationHistory
                    .sort((a, b) => b?.timestamp - a?.timestamp)
                    .map((message, index) => {
                      if (!isLoading && index === 0) {
                        return null;
                      }
                      return (
                        <div
                          key={message.id}
                          className={`p-3 rounded-lg text-sm ${
                            message.role === "user"
                              ? "bg-primary/10 border-l-4 border-primary"
                              : "bg-muted/50"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-medium text-muted-foreground uppercase">
                              {message.role === "user" ? "You" : "AI"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {new Date(message.timestamp).toLocaleTimeString(
                                [],
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }
                              )}
                            </span>
                          </div>
                          <Markdown>{message.content}</Markdown>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
};
