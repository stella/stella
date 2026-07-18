// String normalization shared across registry parsers. Several adapters
// hand-rolled the same "trim, and treat an empty string as absent"
// helper under different names (`nonEmpty`, `trimToNull`, `emptyToNull`)
// with identical semantics. Single-homing it here removes the drift
// risk that produced the DENUE "0" address bug (a blanket
// `=== "0"` clause that only one field genuinely needed).

/**
 * Trim a string and collapse an empty result to `null`. A literal `"0"`
 * is preserved: it is a real value for address atoms (house/local
 * number 0) and only specific fields (e.g. DENUE postal code) use `"0"`
 * as an absent-value sentinel, which those fields must handle
 * explicitly rather than relying on a blanket rule here.
 *
 * Accepts `unknown` on purpose: this normalizes optional fields from
 * upstream registry JSON that the adapter shape guards do not fully
 * validate (recherche-entreprises, for instance, only checks `siret` /
 * `type_dirigeant`, so a numeric `numero_voie` or `denomination` can
 * reach here). Any non-string value is treated as absent (`null`)
 * rather than throwing a raw `TypeError`, matching the per-adapter
 * `trimToNull` helpers this consolidated.
 */
export const trimToNull = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};
