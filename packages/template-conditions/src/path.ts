/**
 * Dotted-path resolution against a data record. Extracted from index.ts so both
 * the condition engine (index.ts) and the arithmetic evaluator (compute.ts) can
 * import it without a dependency cycle.
 */

/** Narrow `unknown` to a string-keyed record. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Resolve a dotted path like `company.name` against data. */
export const resolvePath = (
  path: string,
  data: Record<string, unknown>,
): unknown => {
  // A value may be supplied under the exact dotted key (a flat map, e.g. the
  // fill_template tool's `{ "company.name": ... }`) or nested under each segment
  // (the fill form, which builds `{ company: { name } }`). Prefer the exact key,
  // then walk the nesting, so both callers resolve.
  if (Object.hasOwn(data, path)) {
    return data[path];
  }
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
};
