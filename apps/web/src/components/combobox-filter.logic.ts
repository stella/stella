import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";

/** A string or number as text; anything else carries no text to match. */
const primitiveText = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
};

/**
 * The text Base UI reads for an item when it filters: the item-to-string
 * function, else an object's `label`, else its `value`, else a primitive.
 */
const itemText = <Item>(
  item: Item,
  itemToString: ((item: Item) => string) | undefined,
): string | null => {
  if (itemToString !== undefined) {
    return itemToString(item);
  }
  if (typeof item !== "object" || item === null) {
    return primitiveText(item);
  }
  if ("label" in item && item.label !== null && item.label !== undefined) {
    return primitiveText(item.label);
  }
  return "value" in item ? primitiveText(item.value) : null;
};

/**
 * The `filter` for a `Combobox` or `Command` that filters its own `items`.
 * Base UI's default compares with an `Intl.Collator`, which never finds
 * `strasse` in `Straße` and answers differently per runtime locale, so every
 * picker passes this instead and matches like the rest of the app.
 */
export const matchesComboboxItem = <Item>(
  item: Item,
  query: string,
  itemToString?: (item: Item) => string,
): boolean => createSearchQueryMatcher(query)(itemText(item, itemToString));
