import * as v from "valibot";

/**
 * Parse and validate a JSON string against a Valibot schema, returning
 * `null` on any parse or validation failure.
 *
 * Persisted storage (localStorage/sessionStorage) holds a shape that can
 * drift across releases — a stale key, a renamed field, a value written by
 * an older build. A raw `JSON.parse` trusts that shape and lets a mismatch
 * surface much later as an unrelated crash. This is the single boundary
 * where a persisted string re-enters the type system: parse, validate,
 * and hand back either the typed value or `null` so callers fall back to
 * a default exactly as they would for a missing key.
 */
export const readStoredJson = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  raw: string | null,
  schema: TSchema,
): v.InferOutput<TSchema> | null => {
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = v.safeParse(schema, parsed);
  return result.success ? result.output : null;
};

/**
 * Serialize a value to storage as JSON. Pairs with `readStoredJson` for
 * the read side of the same key. Storage writes can throw (quota
 * exceeded, unavailable in private browsing); persistence of UI-state
 * values like these is best-effort, so failures are swallowed.
 */
export const writeStoredJson = (
  storage: Storage,
  key: string,
  value: unknown,
): void => {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable, full, or blocked; best-effort persistence.
  }
};
