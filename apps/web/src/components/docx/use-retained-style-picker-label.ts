import { useRef } from "react";
import type { CSSProperties, RefObject } from "react";

import { useLayoutSyncEffect } from "@stll/ui/effects";

const STYLE_PICKER_SELECTOR = ".folio-style-picker";
const STYLE_LABEL_SELECTOR = `${STYLE_PICKER_SELECTOR} [data-slot="select-value"]`;

// Whether a mutation touched the style picker: its label changed, or the
// picker itself arrived. Kept to a constant-time check per record, since the
// editor's own content mutates under the same container as the user types.
const touchesStylePicker = (mutation: MutationRecord): boolean => {
  const target =
    mutation.target instanceof Element
      ? mutation.target
      : mutation.target.parentElement;
  return (
    (target?.closest(STYLE_PICKER_SELECTOR) ?? null) !== null ||
    Array.from(mutation.addedNodes).some(
      (node) => node instanceof Element && node.matches(STYLE_PICKER_SELECTOR),
    )
  );
};

/**
 * Remembers the label and look of Folio's style picker so the loading
 * toolbar can show the last style instead of flashing back to "Normal".
 *
 * While the editor is shown (`editorShown`, so `containerRef` holds its
 * container) the picker is read once and again whenever it changes; the last
 * reading stays when the editor gives way to the loading toolbar.
 */
export const useRetainedStylePickerLabel = (
  containerRef: RefObject<HTMLDivElement | null>,
  editorShown: boolean,
) => {
  const lastStyleLabelRef = useRef("Normal");
  const lastStyleLabelStyleRef = useRef<CSSProperties | undefined>(undefined);

  useLayoutSyncEffect(() => {
    const container = containerRef.current;
    if (!editorShown || container === null) {
      return undefined;
    }

    const readStylePicker = () => {
      const styleLabelElement =
        container.querySelector<HTMLElement>(STYLE_LABEL_SELECTOR);
      if (!styleLabelElement) {
        return;
      }

      const stylePreviewElement =
        styleLabelElement.querySelector<HTMLElement>("[style]") ??
        styleLabelElement;
      const styleLabelText = Reflect.get(styleLabelElement, "textContent");
      const styleLabel =
        typeof styleLabelText === "string" ? styleLabelText.trim() : "";

      if (styleLabel.length > 0) {
        lastStyleLabelRef.current = styleLabel;
      }

      const computedStyle = window.getComputedStyle(stylePreviewElement);
      lastStyleLabelStyleRef.current = {
        color: computedStyle.color,
        fontSize: computedStyle.fontSize,
        fontStyle: computedStyle.fontStyle,
        fontWeight: computedStyle.fontWeight,
        lineHeight: computedStyle.lineHeight,
      };
    };

    readStylePicker();
    const observer = new MutationObserver((mutations) => {
      if (mutations.some(touchesStylePicker)) {
        readStylePicker();
      }
    });
    // The label's look changes with its text, in the same commit, so text and
    // child changes are enough.
    observer.observe(container, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
    };
  }, [containerRef, editorShown]);

  /* oxlint-disable react/refs -- the last style label and its look are retained in refs to avoid a loading-state flash */
  return {
    lastStyleLabel: lastStyleLabelRef.current,
    lastStyleLabelStyle: lastStyleLabelStyleRef.current,
  };
  /* oxlint-enable react/refs */
};
