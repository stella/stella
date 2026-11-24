import type { ReactNode } from "react";

import type { PDFColorMode } from "@/lib/pdf/pdf-color-mode";

/**
 * The inspector's PDF viewing state, handed to a legal-file viewer that draws
 * a PDF it holds (a signed container's document): the tab's zoom and colour
 * mode, ctrl or cmd and the wheel, and the floating controls a plain PDF tab
 * shows, placed over the viewer's PDF region.
 */
export type LegalFilePdfView = {
  colorMode: PDFColorMode;
  controls: ReactNode;
  onWheelZoom: (deltaY: number) => void;
  scaleOffset: number;
};
