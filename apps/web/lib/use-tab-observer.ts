import React from "react";

interface TabObserverOptions {
  onActiveTabChange?: (index: number, element: HTMLElement) => void;
}

export function useTabObserver({ onActiveTabChange }: TabObserverOptions = {}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const onActiveTabChangeRef = React.useRef(onActiveTabChange);

  React.useEffect(() => {
    onActiveTabChangeRef.current = onActiveTabChange;
  }, [onActiveTabChange]);

  const handleUpdate = React.useCallback(() => {
    if (listRef.current) {
      const tabs = listRef.current.querySelectorAll('[role="tab"]');
      for (let i = 0; i < tabs.length; i += 1) {
        const el = tabs[i];
        if (!(el instanceof HTMLElement)) {
          continue;
        }
        const isActive =
          el.hasAttribute("data-active") ||
          el.getAttribute("data-state") === "active" ||
          el.getAttribute("aria-selected") === "true";

        if (isActive) {
          onActiveTabChangeRef.current?.(i, el);
          break;
        }
      }
    }
  }, []);

  React.useEffect(() => {
    const resizeObserver = new ResizeObserver(handleUpdate);
    const mutationObserver = new MutationObserver(handleUpdate);

    if (listRef.current) {
      resizeObserver.observe(listRef.current);
      mutationObserver.observe(listRef.current, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    }

    const handleWindowUpdate = () => {
      handleUpdate();
    };

    window.addEventListener("resize", handleWindowUpdate);
    window.addEventListener("orientationchange", handleWindowUpdate);
    document.fonts?.addEventListener?.("loadingdone", handleWindowUpdate);

    handleUpdate();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", handleWindowUpdate);
      window.removeEventListener("orientationchange", handleWindowUpdate);
      document.fonts?.removeEventListener?.("loadingdone", handleWindowUpdate);
    };
  }, [handleUpdate]);

  return { listRef };
}
