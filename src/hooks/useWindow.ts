import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { RefObject, useCallback, useEffect } from "react";

const MIN_HUD_HEIGHT = 54;
const MAX_HUD_HEIGHT = 600;

/**
 * Height the collapsed HUD needs for its own flow content. Grows when context
 * chips are attached or the prompt box wraps to more lines.
 */
let measuredHudHeight = MIN_HUD_HEIGHT;

const clampHudHeight = (height: number): number =>
  Math.min(Math.max(Math.ceil(height), MIN_HUD_HEIGHT), MAX_HUD_HEIGHT);

// Helper function to check if any popover is open in the DOM
const isAnyPopoverOpen = (): boolean => {
  const popoverContents = document.querySelectorAll(
    "[data-radix-popper-content-wrapper]"
  );
  return popoverContents.length > 0;
};

export const useWindowResize = () => {
  const resizeWindow = useCallback(async (expanded: boolean) => {
    try {
      const window = getCurrentWebviewWindow();

      if (!expanded && isAnyPopoverOpen()) {
        return;
      }

      const newHeight = expanded ? MAX_HUD_HEIGHT : measuredHudHeight;

      await invoke("set_window_height", {
        window,
        height: newHeight,
      });
    } catch (error) {
      console.error("Failed to resize window:", error);
    }
  }, []);

  // Setup drag handling and popover monitoring
  useEffect(() => {
    let isDragging = false;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const isDragRegion = target.closest('[data-tauri-drag-region="true"]');

      if (isDragRegion) {
        isDragging = true;
      }
    };

    const handleMouseUp = async () => {
      if (isDragging) {
        isDragging = false;

        setTimeout(() => {
          if (!isAnyPopoverOpen()) {
            resizeWindow(false);
          }
        }, 100);
      }
    };

    const observer = new MutationObserver(() => {
      if (!isAnyPopoverOpen()) {
        resizeWindow(false);
      }
    });

    // Observe the body for changes to detect popover open/close
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      observer.disconnect();
    };
  }, [resizeWindow]);

  return { resizeWindow };
};

/**
 * Keeps the collapsed HUD exactly as tall as its content. Without this the
 * window is a fixed 54px and anything taller than one line gets clipped.
 */
export const useHudAutoHeight = (ref: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(async (entries) => {
      const entry = entries[0];
      if (!entry) return;

      const borderBoxHeight =
        entry.borderBoxSize?.[0]?.blockSize ??
        element.getBoundingClientRect().height;
      const next = clampHudHeight(borderBoxHeight);
      if (next === measuredHudHeight) return;
      measuredHudHeight = next;

      if (isAnyPopoverOpen()) return;

      try {
        await invoke("set_window_height", {
          window: getCurrentWebviewWindow(),
          height: next,
        });
      } catch (error) {
        console.error("Failed to resize window:", error);
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
};

interface UseWindowFocusOptions {
  onFocusLost?: () => void;
  onFocusGained?: () => void;
}

export const useWindowFocus = ({
  onFocusLost,
  onFocusGained,
}: UseWindowFocusOptions = {}) => {
  const handleFocusChange = useCallback(
    async (focused: boolean) => {
      if (focused && onFocusGained) {
        onFocusGained();
      } else if (!focused && onFocusLost) {
        onFocusLost();
      }
    },
    [onFocusLost, onFocusGained]
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupFocusListener = async () => {
      try {
        const window = getCurrentWebviewWindow();

        // Listen to focus change events
        unlisten = await window.onFocusChanged(({ payload: focused }) => {
          handleFocusChange(focused);
        });
      } catch (error) {
        console.error("Failed to setup focus listener:", error);
      }
    };

    setupFocusListener();

    // Cleanup
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleFocusChange]);
};
