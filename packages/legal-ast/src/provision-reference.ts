import * as v from "valibot";

import { normalizeUnicode } from "@stll/text-normalize";

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

const designatorSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(
    (value) => value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value),
    "Invalid provision designator",
  ),
  v.transform((value) => normalizeUnicode(value, "NFC")),
);

export const provisionReferenceSchema = v.object({
  letter: v.nullable(designatorSchema),
  openEnded: v.boolean(),
  point: v.nullable(designatorSchema),
  section: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sectionSuffix: v.nullable(designatorSchema),
  sentence: v.nullable(designatorSchema),
  subsection: v.nullable(designatorSchema),
  unit: v.picklist(["article", "section"]),
}) satisfies v.GenericSchema<ProvisionReference>;
