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

    /**
     * The clipboard suggestion bar and the slash-command menu are positioned
     * absolutely, so they add no flow height and the card's own box does not
     * cover them. Measuring to the lowest edge of the subtree is what keeps the
     * native window from clipping them.
     */
    /**
     * The clipboard suggestion bar and the slash-command menu are positioned
     * absolutely, so they add no flow height and the card's own box does not
     * cover them. Measure to the lowest edge of the subtree instead.
     */
    const contentHeight = (): number => {
      const cardRect = element.getBoundingClientRect();
      let bottom = cardRect.bottom;

      element.querySelectorAll("[data-hud-overlay]").forEach((overlay) => {
        const rect = overlay.getBoundingClientRect();
        if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
      });

      return bottom - cardRect.top;
    };

    const apply = async () => {
      const next = clampHudHeight(contentHeight());
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
    };

    const sizeObserver = new ResizeObserver(() => {
      void apply();
    });
    sizeObserver.observe(element);

    const trackOverlays = () => {
      element
        .querySelectorAll("[data-hud-overlay]")
        .forEach((overlay) => sizeObserver.observe(overlay));
    };
    trackOverlays();

    // An overlay mounting or unmounting leaves the card's own size untouched,
    // so a ResizeObserver alone never hears about it.
    // An overlay slides in with a transform, and a rect reflects that transform,
    // so a measurement taken the moment it mounts reads a box still in motion.
    // Re-measure on the next frame and again when the animation finishes.
    const applySoon = () => {
      void apply();
      requestAnimationFrame(() => void apply());
    };

    const treeObserver = new MutationObserver(() => {
      trackOverlays();
      applySoon();
    });
    treeObserver.observe(element, { childList: true, subtree: true });

    const onAnimationEnd = () => void apply();
    element.addEventListener("animationend", onAnimationEnd, true);
    element.addEventListener("transitionend", onAnimationEnd, true);

    applySoon();

    return () => {
      sizeObserver.disconnect();
      treeObserver.disconnect();
      element.removeEventListener("animationend", onAnimationEnd, true);
      element.removeEventListener("transitionend", onAnimationEnd, true);
    };
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
