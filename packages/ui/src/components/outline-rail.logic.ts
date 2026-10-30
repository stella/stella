import type { OutlineItem } from "./outline-rail";

// Total over the item's fields, so a field added to `OutlineItem` cannot be
// left out of the comparison: an item that differs only in an unlisted field
// would otherwise keep its stale row.
const OUTLINE_ITEM_FIELD_EQUALS = {
  id: (a, b) => a.id === b.id,
  label: (a, b) => a.label === b.label,
  title: (a, b) => a.title === b.title,
  level: (a, b) => a.level === b.level,
  meta: (a, b) => a.meta === b.meta,
  color: (a, b) => a.color === b.color,
  emphasis: (a, b) => a.emphasis === b.emphasis,
} as const satisfies Record<
  keyof OutlineItem,
  (a: OutlineItem, b: OutlineItem) => boolean
>;

const OUTLINE_ITEM_EQUALS = Object.values(OUTLINE_ITEM_FIELD_EQUALS);

const sameOutlineItem = (a: OutlineItem, b: OutlineItem): boolean =>
  OUTLINE_ITEM_EQUALS.every((equals) => equals(a, b));

/**
 * `next` with every entry whose content `previous` already holds under the
 * same id replaced by that earlier object, and `previous` itself when nothing
 * changed. Callers rebuild their items from scratch on every change (an
 * editor re-collects its headings after each edit); reconciling keeps an
 * unchanged entry's identity, so only the rows that actually changed render.
 */
export const reconcileOutlineItems = (
  previous: OutlineItem[],
  next: OutlineItem[],
): OutlineItem[] => {
  if (previous === next) {
    return previous;
  }
  const previousById = new Map<string, OutlineItem>();
  for (const item of previous) {
    previousById.set(item.id, item);
  }
  const reconciled = next.map((item) => {
    const earlier = previousById.get(item.id);
    return earlier !== undefined && sameOutlineItem(earlier, item)
      ? earlier
      : item;
  });
  const unchanged =
    reconciled.length === previous.length &&
    reconciled.every((item, index) => item === previous[index]);
  return unchanged ? previous : reconciled;
};

type RetainKnownIdsOptions = {
  ids: ReadonlySet<string>;
  /** The ids present before `items` replaced them. */
  knownIds: ReadonlySet<string>;
  /** What an id seen for the first time gets. */
  seed: (item: OutlineItem) => boolean;
  items: OutlineItem[];
};

/**
 * Carry a per-entry flag set (collapsed, toggled by hand) across an items
 * change: an entry that was already there keeps the reader's state, an entry
 * seen for the first time gets `seed`, and a removed entry drops out.
 */
export const retainOutlineIdSet = ({
  ids,
  knownIds,
  seed,
  items,
}: RetainKnownIdsOptions): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const item of items) {
    const included = knownIds.has(item.id) ? ids.has(item.id) : seed(item);
    if (included) {
      next.add(item.id);
    }
  }
  return next.size === ids.size && [...next].every((id) => ids.has(id))
    ? ids
    : next;
};
