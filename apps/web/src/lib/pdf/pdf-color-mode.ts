import { panic } from "better-result";

import { DOCX_MIME } from "@/lib/consts";

export const PDF_COLOR_MODES = ["light", "dark", "system"] as const;

export type PDFColorMode = (typeof PDF_COLOR_MODES)[number];

/**
 * Whether the PDF toolbar offers the colour-mode control for a file, by the
 * file's own type: a Word document keeps its editor's bar, and a page made
 * from an image has no page colours to invert. The toolbar and its loading
 * face both decide by this, so the control is in the face exactly when the
 * toolbar that replaces it has it.
 */
export const hasPDFColorControl = (mimeType: string): boolean =>
  mimeType !== DOCX_MIME && !mimeType.startsWith("image/");

type ResolvePDFInvertColorsOptions = {
  colorMode: PDFColorMode;
  isImageOrigin: boolean;
};

export const resolvePDFInvertColors = ({
  colorMode,
  isImageOrigin,
}: ResolvePDFInvertColorsOptions): boolean | undefined => {
  if (isImageOrigin) {
    return false;
  }
  switch (colorMode) {
    case "light":
      return false;
    case "dark":
      return true;
    case "system":
      return undefined;
    default: {
      colorMode satisfies never;
      return panic(`Unhandled color mode: ${String(colorMode)}`);
    }
  }
};
