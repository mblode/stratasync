/**
 * React hook for Yjs presence management.
 * Handles focus/blur signaling based on component visibility and focus state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useSyncClientInstance } from "./use-sync-client.js";
import type { DocumentKey } from "./use-yjs-document.js";

/**
 * Options for useYjsPresence hook.
 */
export interface UseYjsPresenceOptions {
  /** Whether to track focus based on element focus events */
  trackFocus?: boolean;
  /** Whether to track visibility based on Intersection Observer */
  trackVisibility?: boolean;
  /** Skip presence tracking */
  skip?: boolean;
}

/**
 * Result of useYjsPresence hook.
 */
export interface UseYjsPresenceResult {
  /** Start viewing the document */
  startViewing: () => void;
  /** Stop viewing the document */
  stopViewing: () => void;
  /** Signal that the user has focused the editor */
  focus: () => void;
  /** Signal that the user has blurred the editor */
  blur: () => void;
  /** Whether the user is currently viewing */
  isViewing: boolean;
  /** Whether the user is currently editing */
  isEditing: boolean;
  /** Get ref callback for auto-tracking focus/visibility */
  getRef: <T extends HTMLElement>() => (element: T | null) => void;
}

const isSameDocumentKey = (a: DocumentKey, b: DocumentKey): boolean =>
  a.entityType === b.entityType &&
  a.entityId === b.entityId &&
  a.fieldName === b.fieldName;

/**
 * Hook for managing presence signaling in collaborative editing.
 *
 * @param docKey - Document key identifying the field
 * @param options - Hook options
 * @returns UseYjsPresenceResult with presence controls
 *
 * @example
 * ```tsx
 * function TaskEditor({ taskId }: { taskId: string }) {
 *   const { getRef, isViewing, isEditing } = useYjsPresence(
 *     { entityType: 'Task', entityId: taskId, fieldName: 'description' },
 *     { trackFocus: true, trackVisibility: true }
 *   );
 *
 *   return (
 *     <div ref={getRef()}>
 *       <p>Viewing: {isViewing ? 'Yes' : 'No'}</p>
 *       <p>Editing: {isEditing ? 'Yes' : 'No'}</p>
 *       <textarea />
 *     </div>
 *   );
 * }
 * ```
 */
export const useYjsPresence = (
  docKey: DocumentKey,
  options: UseYjsPresenceOptions = {}
): UseYjsPresenceResult => {
  const { trackFocus = false, trackVisibility = false, skip = false } = options;
  const client = useSyncClientInstance();

  const docKeyRef = useRef(docKey);
  const previousDocKeyRef = useRef(docKey);
  const optionsRef = useRef({ skip, trackFocus, trackVisibility });
  docKeyRef.current = docKey;
  optionsRef.current = { skip, trackFocus, trackVisibility };

  const elementRef = useRef<HTMLElement | null>(null);
  const isViewingRef = useRef(false);
  const isEditingRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const focusInHandlerRef = useRef<EventListener | null>(null);
  const focusOutHandlerRef = useRef<EventListener | null>(null);
  const [presenceState, setPresenceState] = useState({
    isEditing: false,
    isViewing: false,
  });

  const getPresenceManager = useCallback(
    () => client.yjs?.presenceManager,
    [client]
  );

  const updatePresenceState = useCallback(
    (isViewing: boolean, isEditing: boolean) => {
      isViewingRef.current = isViewing;
      isEditingRef.current = isEditing;

      setPresenceState((current) => {
        if (
          current.isViewing === isViewing &&
          current.isEditing === isEditing
        ) {
          return current;
        }

        return { isEditing, isViewing };
      });
    },
    []
  );

  const syncPresenceState = useCallback(() => {
    const presenceManager = getPresenceManager();

    if (!presenceManager) {
      updatePresenceState(false, false);
      return;
    }

    updatePresenceState(
      presenceManager.isViewing(docKeyRef.current),
      presenceManager.isEditing(docKeyRef.current)
    );
  }, [getPresenceManager, updatePresenceState]);

  const startViewing = useCallback(() => {
    if (skip || isViewingRef.current) {
      return;
    }

    const presenceManager = getPresenceManager();
    if (presenceManager) {
      presenceManager.startViewing(docKeyRef.current);
      syncPresenceState();
    }
  }, [skip, getPresenceManager, syncPresenceState]);

  const stopViewing = useCallback(() => {
    if (!isViewingRef.current) {
      return;
    }

    const presenceManager = getPresenceManager();
    if (presenceManager) {
      if (isEditingRef.current) {
        presenceManager.blur(docKeyRef.current);
      }
      presenceManager.stopViewing(docKeyRef.current);
      syncPresenceState();
    }
  }, [getPresenceManager, syncPresenceState]);

  const focus = useCallback(() => {
    if (skip) {
      return;
    }

    if (!isViewingRef.current) {
      startViewing();
    }

    if (isEditingRef.current) {
      return;
    }

    const presenceManager = getPresenceManager();
    if (presenceManager) {
      presenceManager.focus(docKeyRef.current);
      syncPresenceState();
    }
  }, [skip, getPresenceManager, startViewing, syncPresenceState]);

  const blur = useCallback(() => {
    if (!isEditingRef.current) {
      return;
    }

    const presenceManager = getPresenceManager();
    if (presenceManager) {
      presenceManager.blur(docKeyRef.current);
      syncPresenceState();
    }
  }, [getPresenceManager, syncPresenceState]);

  const startViewingRef = useRef(startViewing);
  const stopViewingRef = useRef(stopViewing);
  const focusRef = useRef(focus);
  const blurRef = useRef(blur);

  startViewingRef.current = startViewing;
  stopViewingRef.current = stopViewing;
  focusRef.current = focus;
  blurRef.current = blur;

  const detachTrackedElement = useCallback(
    (element: HTMLElement | null = elementRef.current) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (element && focusInHandlerRef.current) {
        element.removeEventListener("focusin", focusInHandlerRef.current);
      }

      if (element && focusOutHandlerRef.current) {
        element.removeEventListener("focusout", focusOutHandlerRef.current);
      }

      focusInHandlerRef.current = null;
      focusOutHandlerRef.current = null;
    },
    []
  );

  const refCallback = useCallback(
    (element: HTMLElement | null) => {
      const previousElement = elementRef.current;

      if (previousElement && previousElement !== element) {
        detachTrackedElement(previousElement);

        if (!element) {
          if (isEditingRef.current) {
            blurRef.current();
          }
          if (isViewingRef.current) {
            stopViewingRef.current();
          }
        }
      }

      elementRef.current = element;

      const currentOptions = optionsRef.current;
      if (!element || currentOptions.skip) {
        return;
      }

      const handleFocusIn: EventListener = () => {
        focusRef.current();
      };

      const handleFocusOut: EventListener = (event) => {
        const focusEvent = event as FocusEvent;
        if (
          elementRef.current &&
          !elementRef.current.contains(focusEvent.relatedTarget as Node | null)
        ) {
          blurRef.current();
        }
      };

      if (currentOptions.trackFocus) {
        focusInHandlerRef.current = handleFocusIn;
        focusOutHandlerRef.current = handleFocusOut;
        element.addEventListener("focusin", handleFocusIn);
        element.addEventListener("focusout", handleFocusOut);
      }

      if (
        currentOptions.trackVisibility &&
        typeof IntersectionObserver !== "undefined"
      ) {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            const isVisible = entries[0]?.isIntersecting ?? false;
            if (isVisible && !isViewingRef.current) {
              startViewingRef.current();
            } else if (!isVisible && isViewingRef.current) {
              stopViewingRef.current();
            }
          },
          { threshold: 0.1 }
        );

        observerRef.current.observe(element);
      }
    },
    [detachTrackedElement]
  );

  const getRef = useCallback(
    <T extends HTMLElement>() => refCallback as (element: T | null) => void,
    [refCallback]
  );

  useEffect(() => {
    syncPresenceState();
  }, [syncPresenceState]);

  useEffect(() => {
    const previousDocKey = previousDocKeyRef.current;
    if (isSameDocumentKey(previousDocKey, docKey)) {
      return;
    }

    previousDocKeyRef.current = docKey;

    const presenceManager = getPresenceManager();
    const wasViewing = isViewingRef.current;
    const wasEditing = isEditingRef.current;

    if (!presenceManager) {
      updatePresenceState(false, false);
      return;
    }

    if (wasEditing) {
      presenceManager.blur(previousDocKey);
    }
    if (wasViewing) {
      presenceManager.stopViewing(previousDocKey);
    }

    if (!skip) {
      if (wasEditing) {
        presenceManager.focus(docKey);
      } else if (wasViewing) {
        presenceManager.startViewing(docKey);
      }
    }

    syncPresenceState();
  }, [
    docKey,
    getPresenceManager,
    skip,
    syncPresenceState,
    updatePresenceState,
  ]);

  useEffect(() => {
    const currentElement = elementRef.current;

    if (!currentElement) {
      if (skip) {
        detachTrackedElement(null);
        if (isEditingRef.current) {
          blur();
        }
        if (isViewingRef.current) {
          stopViewing();
        }
      }
      return;
    }

    detachTrackedElement(currentElement);

    if (skip) {
      if (isEditingRef.current) {
        blur();
      }
      if (isViewingRef.current) {
        stopViewing();
      }
      return;
    }

    refCallback(currentElement);
  }, [
    skip,
    trackFocus,
    trackVisibility,
    detachTrackedElement,
    refCallback,
    blur,
    stopViewing,
  ]);

  useEffect(
    () => () => {
      detachTrackedElement();
      if (isViewingRef.current) {
        stopViewingRef.current();
      }
    },
    [detachTrackedElement]
  );

  return {
    blur,
    focus,
    getRef,
    isEditing: presenceState.isEditing,
    isViewing: presenceState.isViewing,
    startViewing,
    stopViewing,
  };
};
