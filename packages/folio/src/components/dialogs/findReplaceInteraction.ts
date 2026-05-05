import type { FindResult } from "./findReplaceUtils";

export type FindEnterAction = "search" | "next" | "previous";
export type FindDirection = "next" | "previous";

type GetFindEnterActionOptions = {
  searchText: string;
  result: FindResult | null;
  shiftKey: boolean;
};

export function getFindEnterAction({
  searchText,
  result,
  shiftKey,
}: GetFindEnterActionOptions): FindEnterAction {
  if (!searchText.trim() || !result || result.totalCount === 0) {
    return "search";
  }

  return shiftKey ? "previous" : "next";
}

export function getAdjacentFindIndex(
  currentIndex: number,
  totalCount: number,
  direction: FindDirection,
): number {
  if (totalCount <= 0) {
    return 0;
  }

  if (direction === "previous") {
    return currentIndex === 0 ? totalCount - 1 : currentIndex - 1;
  }

  return (currentIndex + 1) % totalCount;
}
