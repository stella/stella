import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

type MatterSearchItem = { id: string; name: string };

type FilterMatterPickerItemsOptions<TItem extends MatterSearchItem> = {
  getClientLabel: (item: TItem) => string;
  items: readonly TItem[];
  query: string;
  selectedId?: string | null | undefined;
};

export const filterMatterPickerItems = <TItem extends MatterSearchItem>({
  getClientLabel,
  items,
  query,
  selectedId,
}: FilterMatterPickerItemsOptions<TItem>): readonly TItem[] => {
  const matches = filterBySearchQuery({
    items,
    query,
    fields: (item) => [item.name, getClientLabel(item)],
  });

  if (
    query.trim().length > 0 ||
    selectedId === null ||
    selectedId === undefined
  ) {
    return matches;
  }

  const selected = matches.find((item) => item.id === selectedId);
  if (selected === undefined) {
    return matches;
  }

  return [selected, ...matches.filter((item) => item.id !== selectedId)];
};
