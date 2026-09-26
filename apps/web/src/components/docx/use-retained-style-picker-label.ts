import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, RefObject } from "react";

/**
 * Remembers the label and look of Folio's style picker so the loading
 * toolbar can show the last style instead of flashing back to "Normal".
 */
export const useRetainedStylePickerLabel = (
  containerRef: RefObject<HTMLDivElement | null>,
) => {
  const lastStyleLabelRef = useRef("Normal");
  const lastStyleLabelStyleRef = useRef<CSSProperties | undefined>(undefined);

  useLayoutEffect(() => {
    const styleLabelElement = containerRef.current?.querySelector<HTMLElement>(
      '.folio-style-picker [data-slot="select-value"]',
    );
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
  });

  /* oxlint-disable react/refs -- the last style label and its look are retained in refs to avoid a loading-state flash */
  return {
    lastStyleLabel: lastStyleLabelRef.current,
    lastStyleLabelStyle: lastStyleLabelStyleRef.current,
  };
  /* oxlint-enable react/refs */
};
