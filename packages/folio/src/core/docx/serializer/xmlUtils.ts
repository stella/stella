/**
 * Shared XML utility functions for serializers.
 */

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format a numeric value as an integer XML attribute.
 *
 * OOXML measure types (twips, EMU, half-points, eighths-of-point) are
 * integer-typed in the schema (xs:unsignedInt / xs:long / xs:int). Word
 * rejects floating-point values (e.g. `0.7 * 1440 === 1008.0000000000001`
 * from `inches * TWIPS_PER_INCH`), even though tolerant readers accept them.
 * Coerce to a finite integer at every serialization site.
 *
 * `NaN`/`Infinity`/`null`/`undefined` collapse to `'0'` rather than leaking
 * literal `"NaN"` or `"Infinity"` into the XML.
 */
export function intAttr(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "0";
  }
  return String(Math.round(value));
}
