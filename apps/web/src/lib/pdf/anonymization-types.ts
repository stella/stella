import type { CharSpan } from "@/lib/anonymize/pdf-coords";

export type EntitySpan = {
  start: number;
  end: number;
  pageIndex: number;
};

export type EntityOverlay = {
  id: number;
  label: string;
  text: string;
  spans: EntitySpan[];
};

export type FileAnonymization = {
  entities: EntityOverlay[];
  perPage: Map<number, EntityOverlay[]>;
  extractedText: string;
  charSpans: CharSpan[];
};
