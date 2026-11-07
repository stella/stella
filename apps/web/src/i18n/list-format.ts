type ListWithMoreOptions = {
  items: readonly string[];
  additionalCount: number;
  formatList: (items: string[]) => string;
  formatMore: (count: number) => string;
};

/** Composes the conjunction once, after the translated count fragment exists. */
export const formatListWithMore = ({
  items,
  additionalCount,
  formatList,
  formatMore,
}: ListWithMoreOptions): string =>
  formatList(
    additionalCount > 0 ? [...items, formatMore(additionalCount)] : [...items],
  );
