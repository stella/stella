/**
 * Lookups in a table keyed by a string read off the wire: an event type, a
 * part type, a tool name, a kind. The string can be one the table does not
 * name, including one every object inherits (`constructor`, `toString`,
 * `__proto__`), which a bare `TABLE[key]` or `key in TABLE` resolves to the
 * prototype's member. Only the table's own entries ever count here.
 */

/** Whether `key` names one of `table`'s own entries. */
export const isOwnKey = <TTable extends object>(
  table: TTable,
  key: PropertyKey,
): key is keyof TTable => Object.hasOwn(table, key);

/**
 * `table`'s own entry for `key`, or `undefined` when it has none. A key the
 * caller already narrowed keeps its narrowed entry type.
 */
export const ownEntry = <TTable extends object, TKey extends PropertyKey>(
  table: TTable,
  key: TKey,
): TTable[TKey & keyof TTable] | undefined =>
  isOwnKey(table, key) ? table[key] : undefined;
