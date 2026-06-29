/**
 * Paragraph base-direction modeled as a discriminated union.
 *
 * Replaces the prior `bidi` + `bidiAuto` PM-attribute flag pair, where
 * combinations such as "auto + ltr" or "auto + undecided" were representable
 * but never valid. The states are now mutually exclusive:
 *
 *   - absent (`null`/`undefined`): undecided — default LTR, eligible for
 *     auto-detection.
 *   - `{ source: "auto" }`: auto-detected RTL; re-evaluated as content changes.
 *   - `{ source: "manual"; value }`: an explicit user toggle or imported
 *     `w:bidi`; authoritative, never auto-revisited.
 *
 * The persisted/serialized model keeps the flat OOXML tri-state
 * (`ParagraphFormatting.bidi: boolean | undefined`); `directionToBidi` /
 * `directionFromBidi` bridge the two at the conversion boundary.
 *
 * Legacy collaborative documents: Yjs fragments persisted before this union
 * carried the old `bidi`/`bidiAuto` PM attrs, which the renamed schema drops on
 * load (ProseMirror ignores attrs it does not declare). Such paragraphs reload
 * as undecided and are re-derived by AutoBidiDetection, so RTL-script content
 * self-heals to `{ source: "auto" }`. There is deliberately no migration; the
 * only lossy case is a paragraph manually forced to LTR over RTL-script text,
 * which reloads undecided and may auto-detect back to RTL.
 */
export type ParagraphDirection =
  | { source: "auto" }
  | { source: "manual"; value: "rtl" | "ltr" };

/** Whether the paragraph lays out and exports right-to-left. */
export const directionIsRtl = (
  direction: ParagraphDirection | null | undefined,
): boolean =>
  direction?.source === "auto" ||
  (direction?.source === "manual" && direction.value === "rtl");

/**
 * Auto-managed paragraphs (undecided, or previously auto-set) are the ones
 * AutoBidiDetection may (re-)evaluate. A manual decision is left untouched.
 */
export const directionIsAutoManaged = (
  direction: ParagraphDirection | null | undefined,
): boolean => direction == null || direction.source === "auto";

/** Map a direction to the serialized OOXML `w:bidi` tri-state. */
export const directionToBidi = (
  direction: ParagraphDirection | null | undefined,
): boolean | undefined => {
  if (direction == null) {
    return undefined;
  }
  if (direction.source === "auto") {
    return true;
  }
  return direction.value === "rtl";
};

/**
 * Reconstruct a direction from a model `bidi` value (DOCX import / load): an
 * explicit `true`/`false` is a manual decision, absence is undecided.
 */
export const directionFromBidi = (
  bidi: boolean | null | undefined,
): ParagraphDirection | null => {
  if (bidi == null) {
    return null;
  }
  return { source: "manual", value: bidi ? "rtl" : "ltr" };
};

/** Runtime guard for the PM attribute validator. */
export const isParagraphDirection = (
  value: unknown,
): value is ParagraphDirection => {
  if (typeof value !== "object" || value === null || !("source" in value)) {
    return false;
  }
  if (value.source === "auto") {
    // `auto` carries no payload; reject a stray `value` so the illegal
    // "auto + ltr/rtl" shape stays unrepresentable.
    return !("value" in value);
  }
  return (
    value.source === "manual" &&
    "value" in value &&
    (value.value === "rtl" || value.value === "ltr")
  );
};
