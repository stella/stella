import { useRef } from "react";
import type { RefObject } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";

import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";
import { isEditableEventTarget } from "@/lib/hotkeys";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";

/**
 * Undo and redo of the reader's own marks, bound to the platform chords while
 * the reader is what the person last pointed at or focused. Text fields keep
 * their own undo: a keystroke typed into one never reaches the marks, and
 * the browser's default stays untouched everywhere the reader does not act.
 *
 * The reader is its text and `surfaceRefs`, the floating bars it portals out
 * of the text.
 */
export const useReaderAnnotationShortcuts = ({
  onRedo,
  onUndo,
  scrollContainerRef,
  surfaceRefs,
}: {
  onRedo: () => Promise<void>;
  onUndo: () => Promise<void>;
  scrollContainerRef: RefObject<HTMLElement | null>;
  surfaceRefs: readonly RefObject<HTMLElement | null>[];
}): void => {
  // Whether the last press or focus landed on the reader. Text selection does
  // not move focus, so focus alone would miss the reader that was just marked.
  const engaged = useRef(false);
  const undo = useLatestCallback(onUndo);
  const redo = useLatestCallback(onRedo);

  useMountEffect(() => {
    const root = scrollContainerRef.current;
    if (root === null) {
      return undefined;
    }
    const controller = new AbortController();
    const follow = (event: Event) => {
      const target = event.target;
      engaged.current =
        target instanceof Node &&
        (root.contains(target) ||
          surfaceRefs.some((ref) => ref.current?.contains(target) === true));
    };
    const options = { capture: true, signal: controller.signal };
    root.ownerDocument.addEventListener("pointerdown", follow, options);
    root.ownerDocument.addEventListener("focusin", follow, options);
    return () => controller.abort();
  });

  const run = (event: KeyboardEvent, step: () => Promise<void>) => {
    if (
      !engaged.current ||
      event.defaultPrevented ||
      isEditableEventTarget(event.target)
    ) {
      return;
    }
    event.preventDefault();
    detached(step(), "legal-reader.annotation-history");
  };
  // The chord only claims the event when the reader acts on it, so every
  // other surface keeps the browser's undo.
  const options = {
    conflictBehavior: "allow",
    ignoreInputs: true,
    preventDefault: false,
    stopPropagation: false,
  } as const;
  useHotkey(
    useEffectiveHotkey("undoReaderAnnotation"),
    (event) => run(event, undo),
    options,
  );
  useHotkey(
    useEffectiveHotkey("redoReaderAnnotation"),
    (event) => run(event, redo),
    options,
  );
};
