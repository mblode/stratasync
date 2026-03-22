// oxlint-disable no-use-before-define -- handleFocusIn/handleFocusOut defined within getRef closure
/**
 * React hook for Yjs presence management.
 * Handles focus/blur signaling based on component visibility and focus state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useSyncClientInstance, useSyncReady } from "./use-sync-client.js";
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
  const isReady = useSyncReady();

  const docKeyRef = useRef(docKey);
  const previousDocKeyRef = useRef(docKey);
  docKeyRef.current = docKey;

  const elementRef = useRef<HTMLElement | null>(null);
  const isViewingRef = useRef(false);
  const isEditingRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
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
    if (!isReady || skip || isViewingRef.current) {
      return;
    }

    const presenceManager = getPresenceManager();
    if (presenceManager) {
      presenceManager.startViewing(docKeyRef.current);
      syncPresenceState();
    }
  }, [isReady, skip, getPresenceManager, syncPresenceState]);

  const stopViewing = useCallback(() => {
    if (!isViewingRef.current) {
      return;
    }

    const presenceManager = getPresenceManager();
    if (presenceManager) {
      presenceManager.stopViewing(docKeyRef.current);
      syncPresenceState();
    }
  }, [getPresenceManager, syncPresenceState]);

  const focus = useCallback(() => {
    if (!isReady || skip) {
      return;
    }

    // Start viewing if not already
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
  }, [isReady, skip, getPresenceManager, startViewing, syncPresenceState]);

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

    if (!skip && isReady) {
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
    isReady,
    skip,
    syncPresenceState,
    updatePresenceState,
  ]);

  // Create ref callback for tracking
  const getRef = useCallback(<T extends HTMLElement>() => {
    return (element: T | null) => {
      // Clean up previous element
      if (elementRef.current && elementRef.current !== element) {
        if (observerRef.current) {
          observerRef.current.disconnect();
          observerRef.current = null;
        }
        elementRef.current.removeEventListener("focusin", handleFocusIn);
        elementRef.current.removeEventListener("focusout", handleFocusOut);
      }

      elementRef.current = element;

      if (!element || skip) {
        return;
      }

      // Set up focus tracking
      if (trackFocus) {
        element.addEventListener("focusin", handleFocusIn);
        element.addEventListener("focusout", handleFocusOut);
      }

      // Set up visibility tracking
      if (trackVisibility && typeof IntersectionObserver !== "undefined") {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            const isVisible = entries[0]?.isIntersecting ?? false;
            if (isVisible && !isViewingRef.current) {
              startViewing();
            } else if (!isVisible && isViewingRef.current) {
              stopViewing();
            }
          },
          { threshold: 0.1 }
        );
        observerRef.current.observe(element);
      }
    };

    const handleFocusIn = () => {
      focus();
    };

    const handleFocusOut = (event: FocusEvent) => {
      // Only blur if focus is leaving the container entirely
      if (
        elementRef.current &&
        !elementRef.current.contains(event.relatedTarget as Node)
      ) {
        blur();
      }
    };
  }, [
    skip,
    trackFocus,
    trackVisibility,
    focus,
    blur,
    startViewing,
    stopViewing,
  ]);

  // Clean up on unmount
  useEffect(
    () => () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      if (isViewingRef.current) {
        stopViewing();
      }
    },
    [stopViewing]
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
