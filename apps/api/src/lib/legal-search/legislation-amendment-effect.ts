import * as v from "valibot";

import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";
import { parsePlainDate } from "@stll/time";

const text = v.pipe(v.string(), v.transform(stripDangerousChars));
const date = v.pipe(
  v.string(),
  v.maxLength(32),
  v.check((value) => parsePlainDate(value) !== null, "Invalid amendment date"),
);
const conditionText = v.pipe(
  text,
  v.maxLength(8192),
  v.check((value) => value.trim().length > 0, "Empty amendment condition"),
);

/** Shared admission schema for ingestion and publisher-channel spools. */
export const legislationAmendmentEffectSchema = v.variant("type", [
  v.object({ type: v.literal("date"), on: date }),
  v.object({ type: v.literal("not-stated"), text: v.nullable(text) }),
  v.object({
    type: v.literal("conditional"),
    condition: v.object({
      text: conditionText,
      label: v.nullable(v.pipe(text, v.maxLength(8192))),
    }),
    workingDate: v.nullable(date),
    actualDate: v.nullable(date),
  }),
]);

export type LegislationAmendmentEffect = v.InferOutput<
  typeof legislationAmendmentEffectSchema
>;
