/**
 * The entity kinds, declared once.
 *
 * Everything that needs the full set derives from this array: the TypeBox
 * validator and the Drizzle column enum in the API, the search facet bounds,
 * the filter guard, and the property-test generators. The hand-written copies
 * this replaces were bound with `satisfies readonly EntityKind[]`, a check
 * that only rejects an extra member; a copy missing one still typechecks, so
 * a new kind could land while a filter or generator silently kept ignoring
 * it.
 */
export const ENTITY_KINDS = [
  "document",
  "folder",
  "task",
  "message",
  "link",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Narrow an untrusted value (a persisted editor attribute, a query string, a
 * third-party payload) to a kind. Callers must keep a `false` result
 * distinguishable from a real kind: substituting a default turns an
 * unresolved value into a confident wrong one.
 */
export const isEntityKind = (value: unknown): value is EntityKind =>
  typeof value === "string" && ENTITY_KINDS.some((kind) => kind === value);
