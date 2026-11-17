import type { PropertyContentType } from "./entity-find";

/**
 * What a property's column orders by. The header names each direction from it
 * (a count lowest first, a name A to Z) and the API picks the column's sort
 * keys from it, so the label and the order cannot disagree. Total over the
 * content types, so a new type does not compile until it says how it orders.
 * A select, a person and a file order by the name they show; money by amount.
 */
export const PROPERTY_SORT_KINDS = {
  file: "text",
  text: "text",
  "single-select": "text",
  "multi-select": "text",
  date: "date",
  int: "number",
  money: "number",
  person: "text",
  // A record has no single value to order by; its projection columns do.
  record: null,
} as const satisfies Record<
  PropertyContentType,
  "date" | "number" | "text" | null
>;
