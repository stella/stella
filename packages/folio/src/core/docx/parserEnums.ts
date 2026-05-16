/**
 * OOXML enum schemas for parser narrowing.
 *
 * Parsers throughout this directory read string-valued XML attributes
 * (`<w:u w:val="single"/>`, `<w:pgBorders w:val="dashed"/>`, …) that
 * the document model types as a small literal union. The historical
 * pattern was `getAttribute(...) as UnderlineStyle`, which lies to
 * the type system: a malformed file produces a typed value that
 * silently contains garbage and breaks downstream consumers.
 *
 * These valibot picklists are the single source of truth for each
 * OOXML enum. `narrowEnum(value, schema)` widens a parsed string to
 * the typed enum *iff* the value is recognised; unknown values
 * become `undefined` so callers can fall back to a default, matching
 * how Word degrades when it doesn't recognise a value.
 *
 * Picklist entries are checked at compile time against the TS union
 * via `satisfies` — a new variant added to the model type fails to
 * compile until the picklist is updated, giving the same compile-time
 * coverage gate as `switch-exhaustiveness-check`.
 */

import * as v from "valibot";

import type {
  BorderSpec,
  ShadingProperties,
  ThemeColorSlot,
} from "../types/document";

/**
 * Narrow a raw attribute string to a picklist member, or `undefined`
 * if the value isn't recognised. The cast lives once inside the
 * valibot output type; callers receive a properly-typed value with
 * no `as` at the call site.
 */
export const narrowEnum = <T extends string>(
  value: string | null | undefined,
  schema: v.PicklistSchema<readonly T[], undefined>,
): T | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const result = v.safeParse(schema, value);
  return result.success ? result.output : undefined;
};

// ---------------------------------------------------------------------------
// Theme & shading enums
// ---------------------------------------------------------------------------

export const ThemeColorSlotSchema = v.picklist([
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
  "background1",
  "text1",
  "background2",
  "text2",
] as const satisfies readonly ThemeColorSlot[]);

export const BorderStyleSchema = v.picklist([
  "none",
  "single",
  "double",
  "dotted",
  "dashed",
  "thick",
  "triple",
  "thinThickSmallGap",
  "thickThinSmallGap",
  "thinThickMediumGap",
  "thickThinMediumGap",
  "thinThickLargeGap",
  "thickThinLargeGap",
  "wave",
  "doubleWave",
  "dashSmallGap",
  "dashDotStroked",
  "threeDEmboss",
  "threeDEngrave",
  "outset",
  "inset",
  "nil",
] as const satisfies readonly BorderSpec["style"][]);

export const ShadingPatternSchema = v.picklist([
  "clear",
  "solid",
  "horzStripe",
  "vertStripe",
  "reverseDiagStripe",
  "diagStripe",
  "horzCross",
  "diagCross",
  "thinHorzStripe",
  "thinVertStripe",
  "thinReverseDiagStripe",
  "thinDiagStripe",
  "thinHorzCross",
  "thinDiagCross",
  "pct5",
  "pct10",
  "pct12",
  "pct15",
  "pct20",
  "pct25",
  "pct30",
  "pct35",
  "pct37",
  "pct40",
  "pct45",
  "pct50",
  "pct55",
  "pct60",
  "pct62",
  "pct65",
  "pct70",
  "pct75",
  "pct80",
  "pct85",
  "pct87",
  "pct90",
  "pct95",
  "nil",
] as const satisfies readonly NonNullable<ShadingProperties["pattern"]>[]);
