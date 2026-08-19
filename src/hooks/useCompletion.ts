import { useState, useCallback, useRef, useEffect } from "react";
import { useWindowResize } from "./useWindow";
import { useGlobalShortcuts } from "@/hooks";
import { MAX_FILES } from "@/config";
import { useApp } from "@/contexts";
import {
  fetchAIResponse,
  saveConversation,
  getConversationById,
  generateConversationTitle,
  MESSAGE_ID_OFFSET,
  generateConversationId,
  generateMessageId,
  generateRequestId,
  getResponseSettings,
  playCompletionSound,
  ContextBlock,
  createFileBlock,
  createPasteBlock,
  isTextFile,
  renderBlocksAsText,
  MAX_BLOCK_BYTES,
  PASTE_AS_BLOCK_THRESHOLD,
  fitHistoryToBudget,
  historyBudgetNotice,
  budgetOverflowNotice,
  runAgentLoopAsText,
  TOOLS,
} from "@/lib";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Unique per attachment: Date.now() alone collides within a millisecond. */
const newAttachmentId = (): string =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Types for completion
interface AttachedFile {
  id: string;
  name: string;
  type: string;
  base64: string;
  size: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attachedFiles?: AttachedFile[];
}

interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface CompletionState {
  input: string;
  response: string;
  isLoading: boolean;
  error: string | null;
  attachedFiles: AttachedFile[];
  contextBlocks: ContextBlock[];
  historyNotice: string | null;
  currentConversationId: string | null;
  conversationHistory: ChatMessage[];
}

export const useCompletion = () => {
  const {
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    screenshotConfiguration,
    setScreenshotConfiguration,
  } = useApp();
  const globalShortcuts = useGlobalShortcuts();

  const [state, setState] = useState<CompletionState>({
    input: "",
    response: "",
    isLoading: false,
    error: null,
    attachedFiles: [],
    contextBlocks: [],
    historyNotice: null,
    currentConversationId: null,
    conversationHistory: [],
  });
  const [micOpen, setMicOpen] = useState(false);
  const [enableVAD, setEnableVAD] = useState(false);
  const [messageHistoryOpen, setMessageHistoryOpen] = useState(false);
  const [isFilesPopoverOpen, setIsFilesPopoverOpen] = useState(false);
  const [isScreenshotLoading, setIsScreenshotLoading] = useState(false);
  const [keepEngaged, setKeepEngaged] = useState(false);
  const [promptHistory, setPromptHistory] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("omni_prompt_history") || localStorage.getItem("pluely_prompt_history");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const promptHistoryIndexRef = useRef<number>(-1);
  // saveCurrentConversation runs after the streaming loop finishes, by which
  // point the state it closed over can be several renders old. Reading through
  // refs removes the whole class of staleness rather than chasing dep arrays.
  const conversationHistoryRef = useRef<ChatMessage[]>([]);
  const currentConversationIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const isProcessingScreenshotRef = useRef(false);
  const screenshotConfigRef = useRef(screenshotConfiguration);
  const hasCheckedPermissionRef = useRef(false);
  const screenshotInitiatedByThisContext = useRef(false);
  // Which attachments are already in the database for this conversation, so images
  // that stay attached across turns are not written once per message.
  const persistedFileIdsRef = useRef<Set<string>>(new Set());

  const { resizeWindow } = useWindowResize();

  useEffect(() => {
    screenshotConfigRef.current = screenshotConfiguration;
  }, [screenshotConfiguration]);

  useEffect(() => {
    conversationHistoryRef.current = state.conversationHistory;
    currentConversationIdRef.current = state.currentConversationId;
  }, [state.conversationHistory, state.currentConversationId]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);

  const setInput = useCallback((value: string) => {
    setState((prev) => ({ ...prev, input: value }));
  }, []);

  const setResponse = useCallback((value: string) => {
    setState((prev) => ({ ...prev, response: value }));
  }, []);

  const addFile = useCallback(async (file: File) => {
    try {
      const base64 = await fileToBase64(file);
      const attachedFile: AttachedFile = {
        id: newAttachmentId(),
        name: file.name,
        type: file.type,
        base64,
        size: file.size,
      };

      setState((prev) => ({
        ...prev,
        attachedFiles: [...prev.attachedFiles, attachedFile],
      }));
    } catch (error) {
      console.error("Failed to process file:", error);
    }
  }, []);

  const removeFile = useCallback((fileId: string) => {
    setState((prev) => ({
      ...prev,
      attachedFiles: prev.attachedFiles.filter((f) => f.id !== fileId),
    }));
  }, []);

  const clearFiles = useCallback(() => {
    setState((prev) => ({ ...prev, attachedFiles: [] }));
  }, []);

  const addContextBlock = useCallback((block: ContextBlock) => {
    setState((prev) => ({
      ...prev,
      contextBlocks: [...prev.contextBlocks, block],
    }));
  }, []);

  const removeContextBlock = useCallback((blockId: string) => {
    setState((prev) => ({
      ...prev,
      contextBlocks: prev.contextBlocks.filter((b) => b.id !== blockId),
    }));
  }, []);

  const addTextFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_BLOCK_BYTES) {
        setState((prev) => ({
          ...prev,
          error: `${file.name} is larger than ${Math.round(
            MAX_BLOCK_BYTES / 1024
          )} KB. Attach a smaller file or paste the relevant section.`,
        }));
        return;
      }
      try {
        const text = await file.text();
        if (text.trim()) {
          addContextBlock(createFileBlock(file.name, text));
        }
      } catch (error) {
        setState((prev) => ({
          ...prev,
          error: `Could not read ${file.name}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        }));
      }
    },
    [addContextBlock]
  );

  const submit = useCallback(
    async (speechText?: string) => {
      const rawInput = speechText || state.input;

      if (!rawInput.trim()) {
        return;
      }

      const trimmedInput = rawInput.trim();

      // Handle /clear slash command
      if (trimmedInput === "/clear") {
        persistedFileIdsRef.current.clear();
        setState((prev) => ({
          ...prev,
          input: "",
          response: "",
          error: null,
          attachedFiles: [],
          contextBlocks: [],
          historyNotice: null,
          currentConversationId: null,
          conversationHistory: [],
        }));
        return;
      }

      // Expand slash commands. A bare command falls back to attached context
      // when there is any, so the clipboard and file chips drive them.
      const argFor = (command: string): string =>
        trimmedInput.slice(command.length).trim();
      const orContext = (text: string, whenEmpty: string): string =>
        text || (state.contextBlocks.length > 0 ? "(use the attached context above)" : whenEmpty);
      const matches = (command: string): boolean =>
        trimmedInput === command || trimmedInput.startsWith(`${command} `);

      // Multi-step is opt-in. Extra round trips on a one-line question would
      // cost the HUD the thing that makes it worth using.
      const useTools = matches("/solve");

      let input = trimmedInput;
      if (useTools) {
        input =
          argFor("/solve") ||
          orContext("", "(no request provided, ask what to solve)");
      } else if (matches("/fix")) {
        input = `Please fix grammar, spelling, clarity, and tone for the following text:\n\n${orContext(argFor("/fix"), "(no text provided, please provide suggestions for writing improvements)")}`;
      } else if (matches("/commit")) {
        input = `You are an expert software engineer. Generate concise, conventional git commit message(s) (format: <type>(<scope>): <summary> followed by key bullet points) based on the following diff or changes:\n\n${orContext(argFor("/commit"), "(Please analyze recent changes or generate conventional commit templates)")}`;
      } else if (matches("/refactor")) {
        input = `Please refactor the following code for maximum performance, readability, modularity, and modern best practices:\n\n${orContext(argFor("/refactor"), "(Please provide general refactoring guidelines)")}`;
      } else if (matches("/translate") || matches("/tr")) {
        const text = trimmedInput.replace(/^\/(translate|tr)\s*/, "").trim();
        input = `Please accurately translate the following text into fluent English (or detected target language):\n\n${orContext(text, "(no text provided)")}`;
      } else if (matches("/explain")) {
        input = `Please explain the following concept simply and clearly with practical examples:\n\n${orContext(argFor("/explain"), "(no topic provided, ask what should be explained)")}`;
      } else if (matches("/code")) {
        input = `Please write clean, production-ready, well-commented code for:\n\n${orContext(argFor("/code"), "(no requirement provided, ask what should be built)")}`;
      } else if (matches("/summarize")) {
        input = `Please summarize the following text into concise bullet points and key takeaways:\n\n${orContext(argFor("/summarize"), "(no text provided, ask what should be summarized)")}`;
      } else if (matches("/regex")) {
        input = `Please explain or construct a regular expression pattern for:\n\n${orContext(argFor("/regex"), "(no pattern provided, ask what the pattern should match)")}`;
      }

      setPromptHistory((prev) => {
        const updated = [
          trimmedInput,
          ...prev.filter((p) => p !== trimmedInput),
        ].slice(0, 50);
        try {
          localStorage.setItem("omni_prompt_history", JSON.stringify(updated));
        } catch {}
        return updated;
      });
      promptHistoryIndexRef.current = -1;

      if (speechText) {
        setState((prev) => ({
          ...prev,
          input: speechText,
        }));
      }

      // Generate unique request ID
      const requestId = generateRequestId();
      currentRequestIdRef.current = requestId;

      // Cancel any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        // Handle image attachments
        const imagesBase64: string[] = [];
        if (state.attachedFiles.length > 0) {
          state.attachedFiles.forEach((file) => {
            if (file.type.startsWith("image/")) {
              imagesBase64.push(file.base64);
            }
          });
        }

        const attachedContext = renderBlocksAsText(state.contextBlocks);
        const userMessage = attachedContext
          ? `${attachedContext}\n\n${input}`
          : input;

        // Trim history to what the model can actually accept. The budget is given
        // the whole turn, not just the typed line: attached files and screenshots
        // are most of the payload in a repo-level question, and counting them as
        // zero is how a session with six files attached hit a provider context
        // error with a full history still in flight.
        const budgeted = fitHistoryToBudget(
          conversationHistoryRef.current.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          { text: input, contextText: attachedContext, imagesBase64 }
        );

        // No amount of dropped history rescues a turn this large, so say what to
        // remove instead of sending it and relaying the provider's rejection.
        if (budgeted.overflow) {
          setState((prev) => ({
            ...prev,
            isLoading: false,
            error: budgetOverflowNotice(budgeted),
          }));
          return;
        }

        const messageHistory = budgeted.turns;
        setState((prev) => ({
          ...prev,
          historyNotice:
            budgeted.droppedCount > 0
              ? historyBudgetNotice(budgeted.droppedCount)
              : null,
        }));

        let fullResponse = "";

        // Check if AI provider is configured
        if (!selectedAIProvider.provider) {
          setState((prev) => ({
            ...prev,
            error: "No AI provider selected. Please select one in settings.",
          }));
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider) {
          setState((prev) => ({
            ...prev,
            error: "AI provider configuration not found. Please check your settings.",
          }));
          return;
        }

        // Clear previous response and set loading state
        setState((prev) => ({
          ...prev,
          isLoading: true,
          error: null,
          response: "",
        }));

        const responseStream = useTools
          ? runAgentLoopAsText({
              fetchAIResponse,
              provider,
              selectedProvider: selectedAIProvider,
              systemPrompt: systemPrompt || undefined,
              history: messageHistory,
              userMessage,
              imagesBase64,
              signal,
              toolNames: Object.keys(TOOLS),
            })
          : fetchAIResponse({
              provider: provider,
              selectedProvider: selectedAIProvider,
              systemPrompt: systemPrompt || undefined,
              history: messageHistory,
              userMessage,
              imagesBase64,
              signal,
            });

        try {
          for await (const chunk of responseStream) {
            // Only update if this is still the current request
            if (currentRequestIdRef.current !== requestId) {
              return; // Request was superseded, stop processing
            }

            // Check if request was aborted
            if (signal.aborted) {
              return; // Request was cancelled, stop processing
            }

            fullResponse += chunk;
            setState((prev) => ({
              ...prev,
              response: prev.response + chunk,
            }));
          }
        } catch (e: any) {
          // Only show error if this is still the current request and not aborted
          if (currentRequestIdRef.current === requestId && !signal.aborted) {
            setState((prev) => ({
              ...prev,
              isLoading: false,
              error: e.message || "An error occurred",
            }));
          }
          return;
        }

        // Only proceed if this is still the current request
        if (currentRequestIdRef.current !== requestId || signal.aborted) {
          return;
        }

        setState((prev) => ({ ...prev, isLoading: false }));
        playCompletionSound();

        // Focus input after AI response is complete
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);

        // Save the conversation after successful completion
        if (fullResponse) {
          // Only the images this turn added. They stay attached for follow-ups, so
          // saving all of them every turn would write the same base64 into the
          // database once per message.
          const newlyAttached = state.attachedFiles.filter(
            (file) => !persistedFileIdsRef.current.has(file.id)
          );
          newlyAttached.forEach((file) =>
            persistedFileIdsRef.current.add(file.id)
          );

          await saveCurrentConversation(input, fullResponse, newlyAttached);

          // Attachments deliberately survive. A screenshot is the subject of the
          // next three questions as often as it is the subject of one, and clearing
          // it here meant the model answered "what line is that on?" about an image
          // it no longer had, from what it had already said about it. They are
          // visible in the paperclip badge and removable there, they are charged
          // against the token budget, and MAX_FILES still caps them.
          setState((prev) => ({
            ...prev,
            input: "",
          }));
        }
      } catch (error) {
        // Only show error if not aborted
        if (!signal?.aborted && currentRequestIdRef.current === requestId) {
          setState((prev) => ({
            ...prev,
            error: error instanceof Error ? error.message : "An error occurred",
            isLoading: false,
          }));
        }
      }
    },
    [
      state.input,
      state.attachedFiles,
      state.contextBlocks,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      // saveCurrentConversation is intentionally absent: it has no deps of its
      // own now, so it is stable for the life of the hook, and it is declared
      // below this point so naming it here would be a use-before-declaration.
    ]
  );

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    currentRequestIdRef.current = null;
    setState((prev) => ({ ...prev, isLoading: false }));
  }, []);

  const reset = useCallback(() => {
    // Don't reset if keep engaged mode is active
    if (keepEngaged) {
      return;
    }
    cancel();
    persistedFileIdsRef.current.clear();
    setState((prev) => ({
      ...prev,
      input: "",
      response: "",
      error: null,
      attachedFiles: [],
      contextBlocks: [],
      historyNotice: null,
    }));
  }, [cancel, keepEngaged]);

  /**
   * Puts the answer away without throwing away what the user assembled.
   *
   * The response panel is controlled by derived state, so it closes both when the
   * user dismisses it and when a new turn clears the previous answer. `reset` was
   * wired to that close, which meant sending a follow-up wiped the attached files
   * and pastes: the chips stayed on screen for one more render while the request
   * went out without them, and the model answered from whatever it already knew
   * about the code. Dismissing clears the answer; only an explicit clear discards
   * the context.
   */
  const dismissResponse = useCallback(() => {
    if (keepEngaged) {
      return;
    }
    cancel();
    setState((prev) => ({
      ...prev,
      response: "",
      error: null,
      historyNotice: null,
    }));
  }, [cancel, keepEngaged]);

  // Helper function to convert file to base64
  const fileToBase64 = useCallback(async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string)?.split(",")[1] || "";
        resolve(base64);
      };
      reader.onerror = reject;
    });
  }, []);

  // Note: saveConversation, getConversationById, and generateConversationTitle
  // are now imported from lib/database/chat-history.action.ts

  const loadConversation = useCallback((conversation: ChatConversation) => {
    setState((prev) => ({
      ...prev,
      currentConversationId: conversation.id,
      conversationHistory: conversation.messages,
      input: "",
      response: "",
      error: null,
      isLoading: false,
    }));
  }, []);

  const startNewConversation = useCallback(() => {
    persistedFileIdsRef.current.clear();
    setState((prev) => ({
      ...prev,
      currentConversationId: null,
      conversationHistory: [],
      input: "",
      response: "",
      error: null,
      isLoading: false,
      attachedFiles: [],
    }));
  }, []);

  const saveCurrentConversation = useCallback(
    async (
      userMessage: string,
      assistantResponse: string,
      attachedFiles: AttachedFile[]
    ) => {
      // Validate inputs
      if (!userMessage || !assistantResponse) {
        console.error("Cannot save conversation: missing message content");
        return;
      }

      const existingConversationId = currentConversationIdRef.current;
      const previousMessages = conversationHistoryRef.current;
      const conversationId =
        existingConversationId || generateConversationId("chat");
      const timestamp = Date.now();

      const userMsg: ChatMessage = {
        id: generateMessageId("user", timestamp),
        role: "user",
        content: userMessage,
        timestamp,
        // The messages.attached_files column has always existed and the DB layer
        // has always written it; this hook was the only thing dropping them.
        attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
      };

      const assistantMsg: ChatMessage = {
        id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
        role: "assistant",
        content: assistantResponse,
        timestamp: timestamp + MESSAGE_ID_OFFSET,
      };

      const newMessages = [...previousMessages, userMsg, assistantMsg];

      // Get existing conversation if updating
      let existingConversation = null;
      if (existingConversationId) {
        try {
          existingConversation = await getConversationById(
            existingConversationId
          );
        } catch (error) {
          console.error("Failed to get existing conversation:", error);
        }
      }

      const title =
        previousMessages.length === 0
          ? generateConversationTitle(userMessage)
          : existingConversation?.title ||
            generateConversationTitle(userMessage);

      const conversation: ChatConversation = {
        id: conversationId,
        title,
        messages: newMessages,
        createdAt: existingConversation?.createdAt || timestamp,
        updatedAt: timestamp,
      };

      try {
        await saveConversation(conversation);

        // Update the refs before the render lands, so a send that arrives in
        // the same tick appends to this conversation instead of forking a new one.
        currentConversationIdRef.current = conversationId;
        conversationHistoryRef.current = newMessages;

        setState((prev) => ({
          ...prev,
          currentConversationId: conversationId,
          conversationHistory: newMessages,
        }));
      } catch (error) {
        console.error("Failed to save conversation:", error);
        // Show error to user
        setState((prev) => ({
          ...prev,
          error: "Failed to save conversation. Please try again.",
        }));
      }
    },
    []
  );

  // Listen for conversation events from the main ChatHistory component
  useEffect(() => {
    const handleConversationSelected = async (event: any) => {
      console.log(event, "event");
      // Only the conversation ID is passed through the event
      const { id } = event.detail;
      console.log(id, "id");
      if (!id || typeof id !== "string") {
        console.error("No conversation ID provided");
        setState((prev) => ({
          ...prev,
          error: "Invalid conversation selected",
        }));
        return;
      }
      console.log(id, "id");
      try {
        // Fetch the full conversation from SQLite
        const conversation = await getConversationById(id);

        if (conversation) {
          loadConversation(conversation);
        } else {
          console.error(`Conversation ${id} not found in database`);
          setState((prev) => ({
            ...prev,
            error: "Conversation not found. It may have been deleted.",
          }));
        }
      } catch (error) {
        console.error("Failed to load conversation:", error);
        setState((prev) => ({
          ...prev,
          error: "Failed to load conversation. Please try again.",
        }));
      }
    };

    const handleNewConversation = () => {
      startNewConversation();
    };

    const handleConversationDeleted = (event: any) => {
      const deletedId = event.detail;
      // If the currently active conversation was deleted, start a new one
      if (state.currentConversationId === deletedId) {
        startNewConversation();
      }
    };

    const handleStorageChange = async (e: StorageEvent) => {
      if ((e.key === "omni-conversation-selected" || e.key === "pluely-conversation-selected") && e.newValue) {
        try {
          const data = JSON.parse(e.newValue);
          const { id } = data;
          if (id && typeof id === "string") {
            const conversation = await getConversationById(id);
            if (conversation) {
              loadConversation(conversation);
            }
          }
        } catch (error) {
          console.error("Failed to parse conversation selection:", error);
        }
      }
    };

    window.addEventListener("conversationSelected", handleConversationSelected);
    window.addEventListener("newConversation", handleNewConversation);
    window.addEventListener("conversationDeleted", handleConversationDeleted);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener(
        "conversationSelected",
        handleConversationSelected
      );
      window.removeEventListener("newConversation", handleNewConversation);
      window.removeEventListener(
        "conversationDeleted",
        handleConversationDeleted
      );
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [loadConversation, startNewConversation, state.currentConversationId]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const MAX_FILES = 6;

    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        if (state.attachedFiles.length < MAX_FILES) {
          addFile(file);
        }
      } else if (isTextFile(file)) {
        addTextFile(file);
      }
    });

    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const handleScreenshotSubmit = useCallback(
    async (base64: string, prompt?: string) => {
      if (state.attachedFiles.length >= MAX_FILES) {
        setState((prev) => ({
          ...prev,
          error: `You can only upload ${MAX_FILES} files`,
        }));
        return;
      }

      try {
        if (prompt) {
          // Auto mode: Submit directly to AI with screenshot
          const attachedFile: AttachedFile = {
            id: newAttachmentId(),
            name: `screenshot_${Date.now()}.png`,
            type: "image/png",
            base64: base64,
            size: base64.length,
          };

          // Generate unique request ID
          const requestId = generateRequestId();
          currentRequestIdRef.current = requestId;

          // Cancel any existing request
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
          }

          abortControllerRef.current = new AbortController();
          const signal = abortControllerRef.current.signal;

          try {
            const budgeted = fitHistoryToBudget(
              conversationHistoryRef.current.map((msg) => ({
                role: msg.role,
                content: msg.content,
              })),
              prompt
            );
            const messageHistory = budgeted.turns;
            setState((prev) => ({
              ...prev,
              historyNotice:
                budgeted.droppedCount > 0
                  ? historyBudgetNotice(budgeted.droppedCount)
                  : null,
            }));

            let fullResponse = "";

            // Check if AI provider is configured
            if (!selectedAIProvider.provider) {
              setState((prev) => ({
                ...prev,
                error: "Please select an AI provider in settings",
              }));
              return;
            }

            const provider = allAiProviders.find(
              (p) => p.id === selectedAIProvider.provider
            );
            if (!provider) {
              setState((prev) => ({
                ...prev,
                error: "Invalid provider selected",
              }));
              return;
            }

            // Clear previous response and set loading state
            setState((prev) => ({
              ...prev,
              input: prompt,
              isLoading: true,
              error: null,
              response: "",
            }));

            // Use the fetchAIResponse function with image and signal
            for await (const chunk of fetchAIResponse({
              provider: provider,
              selectedProvider: selectedAIProvider,
              systemPrompt: systemPrompt || undefined,
              history: messageHistory,
              userMessage: prompt,
              imagesBase64: [base64],
              signal,
            })) {
              // Only update if this is still the current request
              if (currentRequestIdRef.current !== requestId || signal.aborted) {
                return; // Request was superseded or cancelled
              }

              fullResponse += chunk;
              setState((prev) => ({
                ...prev,
                response: prev.response + chunk,
              }));
            }

            // Only proceed if this is still the current request
            if (currentRequestIdRef.current !== requestId || signal.aborted) {
              return;
            }

            setState((prev) => ({ ...prev, isLoading: false }));

            // Focus input after screenshot AI response is complete
            setTimeout(() => {
              inputRef.current?.focus();
            }, 100);

            // Save the conversation after successful completion
            if (fullResponse) {
              await saveCurrentConversation(prompt, fullResponse, [
                attachedFile,
              ]);
              // Clear input after saving
              setState((prev) => ({
                ...prev,
                input: "",
              }));
            }
          } catch (e: any) {
            // Only show error if this is still the current request and not aborted
            if (currentRequestIdRef.current === requestId && !signal.aborted) {
              setState((prev) => ({
                ...prev,
                error: e.message || "An error occurred",
              }));
            }
          } finally {
            // Only update loading state if this is still the current request
            if (currentRequestIdRef.current === requestId && !signal.aborted) {
              setState((prev) => ({ ...prev, isLoading: false }));
            }
          }
        } else {
          // Manual mode: Add to attached files
          const attachedFile: AttachedFile = {
            id: newAttachmentId(),
            name: `screenshot_${Date.now()}.png`,
            type: "image/png",
            base64: base64,
            size: base64.length,
          };

          setState((prev) => ({
            ...prev,
            attachedFiles: [...prev.attachedFiles, attachedFile],
          }));
        }
      } catch (error) {
        console.error("Failed to process screenshot:", error);
        setState((prev) => ({
          ...prev,
          error:
            error instanceof Error
              ? error.message
              : "An error occurred processing screenshot",
          isLoading: false,
        }));
      }
    },
    [
      state.attachedFiles.length,
      state.conversationHistory,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      saveCurrentConversation,
      inputRef,
    ]
  );

  const onRemoveAllFiles = () => {
    clearFiles();
    setIsFilesPopoverOpen(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.isLoading && state.input.trim()) {
        submit();
      }
    } else if (e.key === "ArrowUp") {
      const field = e.currentTarget as HTMLTextAreaElement;
      const caretAtStart = field.selectionStart === 0 && field.selectionEnd === 0;
      if (!state.response && promptHistory.length > 0 && caretAtStart) {
        e.preventDefault();
        const nextIndex = Math.min(
          promptHistoryIndexRef.current + 1,
          promptHistory.length - 1
        );
        promptHistoryIndexRef.current = nextIndex;
        setInput(promptHistory[nextIndex]);
      }
    } else if (e.key === "ArrowDown") {
      const field = e.currentTarget as HTMLTextAreaElement;
      const caretAtEnd =
        field.selectionStart === field.value.length &&
        field.selectionEnd === field.value.length;
      if (!state.response && caretAtEnd) {
        if (promptHistoryIndexRef.current > 0) {
          e.preventDefault();
          const nextIndex = promptHistoryIndexRef.current - 1;
          promptHistoryIndexRef.current = nextIndex;
          setInput(promptHistory[nextIndex]);
        } else if (promptHistoryIndexRef.current === 0) {
          e.preventDefault();
          promptHistoryIndexRef.current = -1;
          setInput("");
        }
      }
    }
  };

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      // Check if clipboard contains images
      const items = e.clipboardData?.items;
      if (!items) return;

      const hasImages = Array.from(items).some((item) =>
        item.type.startsWith("image/")
      );

      // If we have images, prevent default text pasting and process images
      if (hasImages) {
        e.preventDefault();

        const processedFiles: File[] = [];

        Array.from(items).forEach((item) => {
          if (
            item.type.startsWith("image/") &&
            state.attachedFiles.length + processedFiles.length < MAX_FILES
          ) {
            const file = item.getAsFile();
            if (file) {
              processedFiles.push(file);
            }
          }
        });

        // Process all files
        await Promise.all(processedFiles.map((file) => addFile(file)));
        return;
      }

      // A long paste belongs in context, not in a one-line prompt box
      const pastedText = e.clipboardData?.getData("text/plain") ?? "";
      if (pastedText.length > PASTE_AS_BLOCK_THRESHOLD) {
        e.preventDefault();
        addContextBlock(createPasteBlock(pastedText));
      }
    },
    [state.attachedFiles.length, addFile, addContextBlock]
  );

  const isPopoverOpen =
    state.isLoading ||
    state.response !== "" ||
    state.error !== null ||
    keepEngaged;

  useEffect(() => {
    resizeWindow(
      isPopoverOpen || micOpen || messageHistoryOpen || isFilesPopoverOpen
    );
  }, [
    isPopoverOpen,
    micOpen,
    messageHistoryOpen,
    resizeWindow,
    isFilesPopoverOpen,
  ]);

  // Auto scroll to bottom when response updates
  useEffect(() => {
    const responseSettings = getResponseSettings();
    if (
      !keepEngaged &&
      state.response &&
      scrollAreaRef.current &&
      responseSettings.autoScroll
    ) {
      const scrollElement = scrollAreaRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      if (scrollElement) {
        scrollElement.scrollTo({
          top: scrollElement.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  }, [state.response, keepEngaged]);

  // Keyboard arrow key support for scrolling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const activeScrollRef = scrollAreaRef.current || scrollAreaRef.current;
      const scrollElement = activeScrollRef?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen, scrollAreaRef]);

  // Keyboard shortcut for toggling keep engaged mode (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleToggleShortcut = (e: KeyboardEvent) => {
      // Only trigger when popover is open
      if (!isPopoverOpen) return;

      // Check for Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setKeepEngaged((prev) => !prev);
        // Focus the input after toggle (with delay to ensure DOM is ready)
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);
      }
    };

    window.addEventListener("keydown", handleToggleShortcut);
    return () => window.removeEventListener("keydown", handleToggleShortcut);
  }, [isPopoverOpen]);

  const captureScreenshot = useCallback(async () => {
    if (!handleScreenshotSubmit) return;

    const config = screenshotConfigRef.current;
    screenshotInitiatedByThisContext.current = true;
    setIsScreenshotLoading(true);

    try {
      // Check screen recording permission on macOS
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac") && !hasCheckedPermissionRef.current) {
        const {
          checkScreenRecordingPermission,
          requestScreenRecordingPermission,
        } = await import("tauri-plugin-macos-permissions-api");

        const hasPermission = await checkScreenRecordingPermission();

        if (!hasPermission) {
          // Request permission
          await requestScreenRecordingPermission();

          // Wait a moment and check again
          await new Promise((resolve) => setTimeout(resolve, 2000));

          const hasPermissionNow = await checkScreenRecordingPermission();

          if (!hasPermissionNow) {
            setState((prev) => ({
              ...prev,
              error:
                "Screen Recording permission required. Please enable it by going to System Settings > Privacy & Security > Screen & System Audio Recording. If you don't see Omni in the list, click the '+' button to add it. If it's already listed, make sure it's enabled. Then restart the app.",
            }));
            setIsScreenshotLoading(false);
            screenshotInitiatedByThisContext.current = false;
            return;
          }
        }
        hasCheckedPermissionRef.current = true;
      }

      if (config.enabled) {
        const base64 = await invoke("capture_to_base64");

        if (config.mode === "auto") {
          // Auto mode: Submit directly to AI with the configured prompt
          await handleScreenshotSubmit(base64 as string, config.autoPrompt);
        } else if (config.mode === "manual") {
          // Manual mode: Add to attached files without prompt
          await handleScreenshotSubmit(base64 as string);
        }
        screenshotInitiatedByThisContext.current = false;
      } else {
        // Selection Mode: Open overlay to select an area
        isProcessingScreenshotRef.current = false;
        await invoke("start_screen_capture");
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: "Failed to capture screenshot. Please try again.",
      }));
      isProcessingScreenshotRef.current = false;
      screenshotInitiatedByThisContext.current = false;
    } finally {
      if (config.enabled) {
        setIsScreenshotLoading(false);
      }
    }
  }, [handleScreenshotSubmit]);

  useEffect(() => {
    let unlisten: any;

    const setupListener = async () => {
      unlisten = await listen("captured-selection", async (event: any) => {
        if (!screenshotInitiatedByThisContext.current) {
          return;
        }

        if (isProcessingScreenshotRef.current) {
          return;
        }

        isProcessingScreenshotRef.current = true;
        const base64 = event.payload;
        const config = screenshotConfigRef.current;

        try {
          if (config.mode === "auto") {
            // Auto mode: Submit directly to AI with the configured prompt
            await handleScreenshotSubmit(base64 as string, config.autoPrompt);
          } else if (config.mode === "manual") {
            // Manual mode: Add to attached files without prompt
            await handleScreenshotSubmit(base64 as string);
          }
        } catch (error) {
          console.error("Error processing selection:", error);
        } finally {
          setIsScreenshotLoading(false);
          screenshotInitiatedByThisContext.current = false;
          setTimeout(() => {
            isProcessingScreenshotRef.current = false;
          }, 100);
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleScreenshotSubmit]);

  useEffect(() => {
    const unlisten = listen("capture-closed", () => {
      setIsScreenshotLoading(false);
      isProcessingScreenshotRef.current = false;
      screenshotInitiatedByThisContext.current = false;
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const toggleRecording = useCallback(() => {
    setEnableVAD(!enableVAD);
    setMicOpen(!micOpen);
  }, [enableVAD, micOpen]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      currentRequestIdRef.current = null;
    };
  }, []);

  // register callbacks for global shortcuts
  useEffect(() => {
    globalShortcuts.registerAudioCallback(toggleRecording);
    globalShortcuts.registerInputRef(inputRef.current);
    globalShortcuts.registerScreenshotCallback(captureScreenshot);
  }, [
    globalShortcuts.registerAudioCallback,
    globalShortcuts.registerInputRef,
    globalShortcuts.registerScreenshotCallback,
    toggleRecording,
    captureScreenshot,
    inputRef,
  ]);

  return {
    input: state.input,
    setInput,
    response: state.response,
    setResponse,
    isLoading: state.isLoading,
    error: state.error,
    attachedFiles: state.attachedFiles,
    addFile,
    removeFile,
    clearFiles,
    contextBlocks: state.contextBlocks,
    addContextBlock,
    removeContextBlock,
    historyNotice: state.historyNotice,
    submit,
    cancel,
    reset,
    dismissResponse,
    setState,
    enableVAD,
    setEnableVAD,
    micOpen,
    setMicOpen,
    currentConversationId: state.currentConversationId,
    conversationHistory: state.conversationHistory,
    loadConversation,
    startNewConversation,
    messageHistoryOpen,
    setMessageHistoryOpen,
    screenshotConfiguration,
    setScreenshotConfiguration,
    handleScreenshotSubmit,
    handleFileSelect,
    handleKeyPress,
    handlePaste,
    isPopoverOpen,
    scrollAreaRef,
    resizeWindow,
    isFilesPopoverOpen,
    setIsFilesPopoverOpen,
    onRemoveAllFiles,
    inputRef,
    captureScreenshot,
    isScreenshotLoading,
    keepEngaged,
    setKeepEngaged,
  };
};
