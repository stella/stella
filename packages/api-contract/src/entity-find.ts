/**
 * Find: the contract shared by the SQL that filters rows and the toolbar that
 * offers columns to search. A table view and a kanban group both send it.
 *
 * This is not the `search` parameter. `search` is a relevance-ranked typeahead
 * over the asynchronous `search_documents` index; a find is an always-current
 * substring filter over exactly what the grid renders, with no sort keys of
 * its own.
 */

/**
 * The property content types, declared once for the find contract.
 *
 * `PROPERTY_FIND_SUPPORT` is keyed by this list, so a new property type cannot
 * land without a decision about whether it is searchable. The API's
 * `propertyContentTypeSchema` is bound to it by a type-level assertion rather
 * than a hand-kept copy.
 */
export const PROPERTY_CONTENT_TYPES = [
  "file",
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
  "money",
  "person",
] as const;

export type PropertyContentType = (typeof PROPERTY_CONTENT_TYPES)[number];

/**
 * Whether a column can be searched by substring.
 *
 * The three exclusions share one cause: the stored scalar is not the string the
 * cell renders. A date is stored `2026-09-04` and rendered in the reader's
 * locale, an int is stored `1234` and rendered digit-grouped, money is stored
 * as `amountCents` and rendered as a formatted amount (where `%1234%` would
 * also match $12.34). Typing what you see would find nothing, typing the stored
 * form could not be highlighted, and the filter chips already offer the right
 * operations for these types: before/after/between and numeric comparison.
 *
 * Select and multi-select are searchable because options resolve by their
 * stored value, so an ILIKE on that value matches the rendered label.
 */
export const PROPERTY_FIND_SUPPORT = {
  file: "searchable",
  text: "searchable",
  "single-select": "searchable",
  "multi-select": "searchable",
  person: "searchable",
  date: "excluded",
  int: "excluded",
  money: "excluded",
} as const satisfies Record<PropertyContentType, "searchable" | "excluded">;

export const isFindablePropertyType = (type: PropertyContentType): boolean =>
  PROPERTY_FIND_SUPPORT[type] === "searchable";

/**
 * How wide the find reaches.
 *
 * `all` is the unrestricted state: the entity's name (the string a name column
 * renders, not the display-name fallback chain) or any of the listed columns,
 * and matching column headers highlight. `columns` is the narrowed state: only
 * the listed columns, with no name half and no header highlight. Both carry an explicit property list, because the group-counts
 * endpoint receives no field selection and so cannot recompute a default that
 * would agree with the rows.
 */
export const ENTITY_FIND_SCOPE_TYPES = ["all", "columns"] as const;

export type EntityFindScopeType = (typeof ENTITY_FIND_SCOPE_TYPES)[number];

export type EntityFindScope = {
  propertyIds: readonly string[];
  type: EntityFindScopeType;
};

/**
 * A find, whole: the term and how wide it reaches, in one object.
 *
 * Deliberately not two loose optional fields. A term that arrived without a
 * scope would be a third behaviour ("the name, and nothing else") that
 * `ENTITY_FIND_SCOPE_TYPES` does not name and no caller wants; pairing them
 * structurally makes it unrepresentable rather than documented.
 */
export type EntityFind = {
  scope: EntityFindScope;
  term: string;
};
