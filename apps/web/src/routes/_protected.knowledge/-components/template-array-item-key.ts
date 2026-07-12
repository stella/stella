/** Array item inputs as named by ArrayFieldRenderer: `<path>[<index>].<sub>`. */
const ARRAY_ITEM_KEY_RE = /^(?<path>.+)\[(?<index>\d+)\]\.(?<sub>.+)$/u;

export type ArrayItemKey = {
  /** The array field's path. */
  path: string;
  index: number;
  /** The item sub-field's path within the array field. */
  sub: string;
};

/** Parse a form-state key into its array item parts; null for scalar keys. */
export const parseArrayItemKey = (key: string): ArrayItemKey | null => {
  const { path, index, sub } = ARRAY_ITEM_KEY_RE.exec(key)?.groups ?? {};
  if (path === undefined || index === undefined || sub === undefined) {
    return null;
  }
  return { path, index: Number(index), sub };
};
