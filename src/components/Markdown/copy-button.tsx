import { useEffect } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks";
import { Button } from "@/components/ui/button";

type CopyButtonProps = {
  content: string;
  copyMessage?: string;
};

export function CopyButton({ content, copyMessage }: CopyButtonProps) {
  const { isCopied, handleCopy } = useCopyToClipboard({
    text: content,
    copyMessage,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "c" || e.key === "C") && content) {
        e.preventDefault();
        handleCopy();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [content, handleCopy]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-6 w-6 cursor-pointer"
      aria-label="Copy to clipboard"
      title="Copy to clipboard (⌥C)"
      onClick={handleCopy}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <Check
          className={cn(
            "h-4 w-4 transition-transform ease-in-out",
            isCopied ? "scale-100" : "scale-0"
          )}
        />
      </div>
      <Copy
        className={cn(
          "h-4 w-4 transition-transform ease-in-out",
          isCopied ? "scale-0" : "scale-100"
        )}
      />
    </Button>
  );
}
