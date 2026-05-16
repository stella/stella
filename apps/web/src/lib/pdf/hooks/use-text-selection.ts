import { useEffect } from "react";
import type { RefObject } from "react";

import { EOC_CLASS_NAME, TEXT_LAYER_ATTRIBUTE } from "@/lib/pdf/consts";

/**
 * Manages text selection across PDF text layers.
 * Handles End-of-Content marker positioning for
 * proper cross-page selection behavior.
 */
export const useTextSelection = (
  containerRef: RefObject<HTMLDivElement | null>,
) => {
  useEffect(() => {
    let prevRange: Range | null = null;

    const updateSelectionMarkers = () => {
      const selection = document.getSelection();
      const textLayers = getTextLayers(containerRef.current);

      if (textLayers.length === 0) {
        return;
      }

      if (!selection || selection.rangeCount === 0) {
        resetEndMarkers(textLayers);
        return;
      }

      const activeTextLayers = getActiveTextLayers(selection, textLayers);
      updateEndMarkers(textLayers, activeTextLayers);

      const range = selection.getRangeAt(0);
      const modifyStart =
        prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      const anchor = getSelectionAnchor(range, Boolean(modifyStart));
      moveEndMarker(anchor, Boolean(modifyStart));

      prevRange = range.cloneRange();
    };

    document.addEventListener("selectionchange", updateSelectionMarkers);

    return () => {
      document.removeEventListener("selectionchange", updateSelectionMarkers);
    };
  }, [containerRef]);
};

const getTextLayers = (container: HTMLDivElement | null): HTMLDivElement[] => {
  if (!container) {
    return [];
  }

  return [
    ...container.querySelectorAll<HTMLDivElement>(`[${TEXT_LAYER_ATTRIBUTE}]`),
  ];
};

const getEndMarker = (textLayer: Element) =>
  textLayer.querySelector<HTMLDivElement>(`.${EOC_CLASS_NAME}`);

const resetEndMarkers = (textLayers: readonly HTMLDivElement[]) => {
  for (const textLayer of textLayers) {
    const eoc = getEndMarker(textLayer);
    if (!eoc) {
      continue;
    }

    eoc.style.display = "none";
    textLayer.append(eoc);
  }
};

const getActiveTextLayers = (
  selection: Selection,
  textLayers: readonly HTMLDivElement[],
) => {
  const activeTextLayers = new Set<Element>();

  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    for (const textLayer of textLayers) {
      if (activeTextLayers.has(textLayer)) {
        continue;
      }

      if (range.intersectsNode(textLayer)) {
        activeTextLayers.add(textLayer);
      }
    }
  }

  return activeTextLayers;
};

const updateEndMarkers = (
  textLayers: readonly HTMLDivElement[],
  activeTextLayers: ReadonlySet<Element>,
) => {
  for (const textLayer of textLayers) {
    const eoc = getEndMarker(textLayer);

    if (!eoc) {
      continue;
    }

    if (activeTextLayers.has(textLayer)) {
      eoc.style.display = "block";
      continue;
    }

    eoc.style.display = "none";
    textLayer.append(eoc);
  }
};

const getSelectionAnchor = (range: Range, modifyStart: boolean) => {
  const rangeContainer = modifyStart
    ? range.startContainer
    : range.endContainer;
  let anchor = getElementBackedNode(rangeContainer);

  if (!modifyStart && range.endOffset === 0) {
    anchor = getPreviousTextNodeAnchor(anchor);
  }

  return anchor;
};

const getElementBackedNode = (node: Node) => {
  if (node.nodeType === Node.TEXT_NODE && node.parentNode) {
    return node.parentNode;
  }

  return node;
};

const getPreviousTextNodeAnchor = (node: Node) => {
  let anchor = node;

  while (true) {
    while (!anchor.previousSibling) {
      if (!anchor.parentNode) {
        return anchor;
      }
      anchor = anchor.parentNode;
    }

    anchor = anchor.previousSibling;

    if (anchor.childNodes.length > 0) {
      return anchor;
    }
  }
};

const moveEndMarker = (anchor: Node, modifyStart: boolean) => {
  const parentTextLayer = anchor.parentElement?.closest(
    `[${TEXT_LAYER_ATTRIBUTE}]`,
  );
  const eoc = parentTextLayer ? getEndMarker(parentTextLayer) : null;

  if (!eoc) {
    return;
  }

  anchor.parentElement?.insertBefore(
    eoc,
    modifyStart ? anchor : anchor.nextSibling,
  );
};
