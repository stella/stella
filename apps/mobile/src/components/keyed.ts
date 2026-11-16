/**
 * Each item with a key made of what it says, told apart from earlier items
 * that say the same: a step that ran twice, two equal table cells.
 */
export const keyedBy = <TItem>(
  items: readonly TItem[],
  name: (item: TItem) => string,
): { item: TItem; key: string }[] => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const named = name(item);
    const earlier = seen.get(named) ?? 0;
    seen.set(named, earlier + 1);
    return { item, key: `${named}#${String(earlier)}` };
  });
};
