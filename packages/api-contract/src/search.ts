import { ENTITY_KINDS } from "./entity-kinds";

export const GLOBAL_SEARCH_RESULT_TYPES = [
  "matter",
  "contact",
  "case-law",
  ...ENTITY_KINDS,
  // Appended last on purpose: Elysia coerces an absent optional UnionEnum to
  // the first element, so new types must never take slot 0.
  "chat",
] as const;

export type GlobalSearchResultType =
  (typeof GLOBAL_SEARCH_RESULT_TYPES)[number];
