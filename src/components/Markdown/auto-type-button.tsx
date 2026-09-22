import { useState, useEffect, useCallback } from "react";
import { Keyboard, Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";

interface AutoTypeButtonProps {
  content: string;
}

export function extractCodeToType(markdown: string): string {
  if (!markdown) return "";
  
  // Find all fenced code blocks (```lang\n...\n```)
  const codeBlockRegex = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  const matches = [...markdown.matchAll(codeBlockRegex)];
  
  if (matches.length > 0) {
    // Join extracted code blocks with a double newline
    return matches.map((m) => m[1].trimEnd()).join("\n\n");
  }
  
  // If no fenced code blocks, return the raw markdown content
  return markdown.trim();
}

export function AutoTypeButton({ content }: AutoTypeButtonProps) {
  const [isTyping, setIsTyping] = useState(false);

  const stopTyping = useCallback(async () => {
    try {
      await invoke("cancel_human_typing");
    } catch (e) {
      console.error("Failed to cancel human typing:", e);
    } finally {
      setIsTyping(false);
    }
  }, []);

  const handleStartTyping = async () => {
    if (isTyping) {
      await stopTyping();
      return;
    }

    const code = extractCodeToType(content);
    if (!code) return;

    try {
      setIsTyping(true);
      await invoke("simulate_human_typing", { text: code, speedWpm: 105 });
    } catch (error) {
      console.error("Typing simulation error:", error);
    } finally {
      setIsTyping(false);
    }
  };

  // Allow triggering with Alt+T and canceling with Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTyping) {
        e.preventDefault();
        stopTyping();
      } else if (e.altKey && (e.key === "t" || e.key === "T") && content) {
        e.preventDefault();
        handleStartTyping();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isTyping, stopTyping, content]);

  if (!content) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-6 cursor-pointer hover:bg-primary/10 hover:text-primary transition-colors rounded-md"
      aria-label={isTyping ? "Stop auto-typing" : "Type code into active editor"}
      title={isTyping ? "Typing in progress... Click or press Esc to stop" : "Simulate human typing into active editor (Alt+T)"}
      onClick={handleStartTyping}
    >
      {isTyping ? (
        <div className="flex items-center justify-center">
          <Square className="size-3 fill-destructive text-destructive animate-pulse" />
        </div>
      ) : (
        <Keyboard className="size-3.5 opacity-80 hover:opacity-100 transition-opacity" />
      )}
    </Button>
  );
}
