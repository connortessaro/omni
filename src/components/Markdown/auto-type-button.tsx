import { useState, useEffect, useCallback } from "react";
import { Keyboard, Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";

import { parseAnswer } from "@/lib/assessment";

interface AutoTypeButtonProps {
  content: string;
}

interface ExtractedBlock {
  lang: string;
  code: string;
}

function parseCodeBlocks(markdown: string): ExtractedBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: ExtractedBlock[] = [];
  let openFence: { char: string; len: number; lang: string } | null = null;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);

    if (openFence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === openFence.char &&
        fenceMatch[1].length >= openFence.len
      ) {
        blocks.push({
          lang: openFence.lang,
          code: currentLines.join("\n"),
        });
        openFence = null;
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    } else if (fenceMatch) {
      const char = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      const info = fenceMatch[2].trim();
      const lang = info.split(/\s+/)[0]?.toLowerCase() || "";
      openFence = { char, len, lang };
      currentLines = [];
    }
  }

  // Gracefully recover unclosed code block (e.g. streaming or malformed markdown)
  if (openFence && currentLines.length > 0) {
    blocks.push({
      lang: openFence.lang,
      code: currentLines.join("\n"),
    });
  }

  return blocks;
}

export function extractCodeToType(markdown: string): string {
  if (!markdown) return "";

  // 1. If this is a structured Omni assessment with an ```omni contract, use its clean body
  const parsed = parseAnswer(markdown);
  const targetMarkdown = parsed ? parsed.body : markdown;

  // 2. Parse fenced code blocks with support for nested fences, CRLF, info strings, and language identifiers
  const blocks = parseCodeBlocks(targetMarkdown);

  // 3. Filter out 'omni' contract blocks
  const nonOmni = blocks.filter((b) => b.lang !== "omni");

  // 4. Filter out test-runner checks so test harness assertions aren't typed into online coding platforms.
  // Uses word boundaries and delimiter checks so variables like 'assertion_count' or words like 'assertive' are safely preserved.
  const isTestHarness = (code: string): boolean =>
    /(^|\n)\s*(assert(\s+|\(|\.)|pytest\b|console\.assert\b|unittest\b)/.test(code);

  const solutionBlocks = nonOmni.filter((b) => !isTestHarness(b.code));

  // If test filtering left solution blocks, use them. If all blocks matched (e.g. defensive assertion inside
  // solution or standalone test query), keep the non-omni blocks rather than falling back to prose.
  const targetBlocks = solutionBlocks.length > 0 ? solutionBlocks : nonOmni;

  if (targetBlocks.length > 0) {
    return targetBlocks.map((b) => b.code.trimEnd()).join("\n\n");
  }

  // Fallback: If no pure solution block was found, return raw body without omni fence
  return targetMarkdown.replace(/```omni[\s\S]*?```/g, "").trim();
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
