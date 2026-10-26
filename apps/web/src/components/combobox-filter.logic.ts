import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";

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
  if (typeof item === "string") {
    return item;
  }
  if (typeof item === "number" || typeof item === "bigint") {
    return String(item);
  }
  if (typeof item !== "object" || item === null) {
    return null;
  }
  if ("label" in item && item.label !== null && item.label !== undefined) {
    return String(item.label);
  }
  return "value" in item ? String(item.value) : null;
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
