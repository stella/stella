/**
 * The jurisdiction-neutral shape a provision citation resolves to.
 *
 * Only the structure lives here. The words its subdivisions are named with
 * (`odst.`, `ust.`, `para.`) are the renderer's, because they are bound to the
 * jurisdiction and to the reader's language; the numbers and the section sign
 * are the citation itself and travel with the shape.
 */

export type ProvisionUnit = "article" | "section";

/** Named subdivisions, i.e. everything the catalog has a word for. */
export type ProvisionPartKey =
  | "article"
  | "letter"
  | "openEnded"
  | "point"
  | "sentence"
  | "subsection";

export type ProvisionReference = {
  letter: string | null;
  /** The reference runs on from here (`et seq.`, `a násl.`). */
  openEnded: boolean;
  point: string | null;
  section: number;
  /** An inserted provision's letter: `265` + `b`. */
  sectionSuffix: string | null;
  sentence: string | null;
  subsection: string | null;
  unit: ProvisionUnit;
};
