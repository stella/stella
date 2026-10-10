import { useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { selectionToolbarBounds } from "@/components/selection-toolbar.logic";
import type { SelectionToolbarAnchor } from "@/components/selection-toolbar.logic";
import { useMountEffect } from "@/hooks/use-effect";

type ChatSelectionEventsOptions = {
  rootRef: RefObject<HTMLElement | null>;
  readSelection: (
    ownerDoc: Document,
    pointer?: { x: number; y: number },
  ) => void;
  setDoc: Dispatch<SetStateAction<Document | null>>;
  setConfirmAt: Dispatch<SetStateAction<SelectionToolbarAnchor | null>>;
};

const sameRect = (a: DOMRect, b: DOMRect): boolean =>
  a.left === b.left &&
  a.top === b.top &&
  a.right === b.right &&
  a.bottom === b.bottom;

export const useChatSelectionEvents = ({
  rootRef,
  readSelection,
  setDoc,
  setConfirmAt,
}: ChatSelectionEventsOptions) => {
  const ignorePointerSelectionChange = useRef(false);
  useMountEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      setDoc(null);
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    setDoc(ownerDoc);
    let frame = 0;
    const onChange = () => {
      if (ignorePointerSelectionChange.current) {
        ignorePointerSelectionChange.current = false;
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => readSelection(ownerDoc));
    };
    const onPointerUp = (event: PointerEvent) => {
      const NodeConstructor = ownerDoc.defaultView?.Node;
      if (
        NodeConstructor === undefined ||
        !(event.target instanceof NodeConstructor) ||
        !root.contains(event.target)
      ) {
        return;
      }
      cancelAnimationFrame(frame);
      ignorePointerSelectionChange.current = true;
      readSelection(ownerDoc, { x: event.clientX, y: event.clientY });
    };
    const onKeyDown = () => {
      // A keyboard-modified range belongs to its textual end, not the last
      // pointer position that happened to create an earlier selection.
      ignorePointerSelectionChange.current = false;
    };
    const onScroll = () => {
      ignorePointerSelectionChange.current = false;
      onChange();
    };
    const updateConfirmationBounds = () => {
      const bounds = selectionToolbarBounds(root);
      if (bounds === null) {
        setConfirmAt(null);
        return;
      }
      setConfirmAt((current) => {
        if (current === null || sameRect(current.bounds, bounds)) {
          return current;
        }
        return { bounds, rect: current.rect };
      });
    };
    const onLayoutChange = () => {
      onScroll();
      updateConfirmationBounds();
    };
    const controller = new AbortController();
    ownerDoc.addEventListener("selectionchange", onChange, {
      signal: controller.signal,
    });
    ownerDoc.addEventListener("pointerup", onPointerUp, {
      capture: true,
      signal: controller.signal,
    });
    ownerDoc.addEventListener("keydown", onKeyDown, {
      capture: true,
      signal: controller.signal,
    });
    // The transcript scrolls (and streams) under a selection; the bar
    // follows the words, and hides once they leave the transcript. A
    // confirmation ignores scrolling: opening the side panel narrows and
    // scrolls the transcript itself, so only a new selection or its timeout
    // ends it, and it stays where the reader was looking.
    ownerDoc.addEventListener("scroll", onLayoutChange, {
      capture: true,
      passive: true,
      signal: controller.signal,
    });
    ownerDoc.defaultView?.addEventListener("resize", onLayoutChange, {
      signal: controller.signal,
    });
    const ResizeObserverConstructor = ownerDoc.defaultView?.ResizeObserver;
    const resizeObserver =
      ResizeObserverConstructor === undefined
        ? null
        : new ResizeObserverConstructor(onLayoutChange);
    resizeObserver?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
      resizeObserver?.disconnect();
    };
  });
};
