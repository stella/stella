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
    const ac = new AbortController();

    document.addEventListener(
      "selectionchange",
      () => {
        const selection = document.getSelection();
        const textLayers =
          containerRef.current?.querySelectorAll<HTMLDivElement>(
            `[${TEXT_LAYER_ATTRIBUTE}]`,
          );

        if (!textLayers) {
          return;
        }

        if (!selection || selection.rangeCount === 0) {
          for (const textLayer of textLayers) {
            const eoc = textLayer.querySelector<HTMLDivElement>(
              `.${EOC_CLASS_NAME}`,
            );
            if (eoc) {
              eoc.style.display = "none";
              textLayer.append(eoc);
            }
          }
          return;
        }

        const activeTextLayers = new Set<Element>();

        for (let i = 0; i < selection.rangeCount; i++) {
          const range = selection.getRangeAt(i);
          for (const textLayer of textLayers) {
            if (
              !activeTextLayers.has(textLayer) &&
              range.intersectsNode(textLayer)
            ) {
              activeTextLayers.add(textLayer);
            }
          }
        }

        for (const textLayer of textLayers) {
          const eoc = textLayer.querySelector<HTMLDivElement>(
            `.${EOC_CLASS_NAME}`,
          );

          if (!eoc) {
            continue;
          }

          if (activeTextLayers.has(textLayer)) {
            eoc.style.display = "block";
          } else {
            eoc.style.display = "none";
            textLayer.append(eoc);
          }
        }

        const range = selection.getRangeAt(0);
        const modifyStart =
          prevRange &&
          (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
            range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);

        let anchor: Node = modifyStart
          ? range.startContainer
          : range.endContainer;

        if (anchor.nodeType === Node.TEXT_NODE && anchor.parentNode) {
          anchor = anchor.parentNode;
        }

        if (!modifyStart && range.endOffset === 0) {
          do {
            while (!anchor.previousSibling) {
              if (!anchor.parentNode) {
                break;
              }
              anchor = anchor.parentNode;
            }

            if (!anchor.previousSibling) {
              break;
            }

            anchor = anchor.previousSibling;
          } while (!anchor.childNodes.length);
        }

        const parentTextLayer = anchor.parentElement?.closest(
          `[${TEXT_LAYER_ATTRIBUTE}]`,
        );
        const eoc = parentTextLayer?.querySelector<HTMLDivElement>(
          `.${EOC_CLASS_NAME}`,
        );

        if (eoc) {
          anchor.parentElement?.insertBefore(
            eoc,
            modifyStart ? anchor : anchor.nextSibling,
          );
        }

        prevRange = range.cloneRange();
      },
      { signal: ac.signal },
    );

    return () => ac.abort();
  }, [containerRef]);
};
