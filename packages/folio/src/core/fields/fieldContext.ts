/**
 * Resolution context for evaluating dynamic DOCX fields against a laid-out
 * document. Built once per layout pass (see the field-resolution pass) and
 * consumed by {@link evaluateField}. All position-dependent values
 * (page numbers, bookmark pages, SEQ counters) are resolved against the current
 * layout so a field paints the same value its width was measured against.
 */
export type FieldContext = {
  /** 1-indexed page the field is on (PAGE). */
  pageNumber: number;
  /** Total pages in the document (NUMPAGES). */
  totalPages: number;
  /** Pages in the field's current section (SECTIONPAGES). */
  sectionPages: number;
  /** Bookmark name -> 1-indexed page it lands on (PAGEREF). */
  bookmarkPages: ReadonlyMap<string, number>;
  /** Bookmark name -> resolved display text (REF). */
  bookmarkText: ReadonlyMap<string, string>;
  /** Field instance id (the run's `pmStart`) -> precomputed SEQ value. */
  seqValues: ReadonlyMap<number, number>;
  /** Clock for DATE/TIME-family fields; passed in so evaluation stays pure. */
  now: Date;
};
