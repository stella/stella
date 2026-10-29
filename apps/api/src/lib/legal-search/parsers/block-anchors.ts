/** One namespace for every block anchor allocated during a document parse. */
export const createBlockAnchorAllocator = () => {
  const emitted = new Set<string>();
  const suffixes = new Map<string, number>();
  return (preferred: string): string => {
    let anchor = preferred;
    let suffix = suffixes.get(preferred) ?? 1;
    while (emitted.has(anchor)) {
      suffix += 1;
      anchor = `${preferred}-${suffix}`;
    }
    suffixes.set(preferred, suffix);
    emitted.add(anchor);
    return anchor;
  };
};
