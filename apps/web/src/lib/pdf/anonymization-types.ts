import type { PdfAnonymizationText } from "@/lib/anonymize/pdf-anonymization-geometry";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";

export type EntityOverlay = {
  id: number;
  label: string;
  text: string;
  /** The occurrence's glyph boxes in PDF user space, merged per run. */
  boxesByPage: ReadonlyMap<number, readonly PDFSearchBox[]>;
};

export type FileAnonymization = {
  entities: EntityOverlay[];
  perPage: Map<number, EntityOverlay[]>;
  extraction: PdfAnonymizationText;
};
