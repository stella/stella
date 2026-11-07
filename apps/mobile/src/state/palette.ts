import { foldSearchMatchText } from "@stll/text-normalize";

/** One thing the command palette can run or open. */
export type PaletteItem = {
  readonly key: string;
  readonly kind: "action" | "matter" | "chat";
  readonly title: string;
  readonly detail?: string | undefined;
  /** Other words it answers to: a matter's client and reference, an action's synonyms. */
  readonly terms: readonly string[];
};

/** How many matters and chats a query lists, so the actions above stay in view. */
export const PALETTE_ENTITY_LIMIT = 8;

/**
 * Lower case without accents, so "smlouva" finds "Smlouva" and "zaloba"
 * finds "Žaloba", as a person types on a keyboard without the accents; the
 * web's search folds the same way.
 */
export const foldText = foldSearchMatchText;

/** 0 when the title starts with the query, 1 when one of its words does, 2 anywhere else, null without a match. */
const scoreOf = (
  item: PaletteItem,
  query: string,
  words: readonly string[],
) => {
  const title = foldText(item.title);
  const haystack = [title, ...item.terms.map(foldText)].join(" ");
  if (!words.every((word) => haystack.includes(word))) {
    return null;
  }
  if (title.startsWith(query)) {
    return 0;
  }
  return title.split(/\s+/u).some((part) => part.startsWith(words[0] ?? ""))
    ? 1
    : 2;
};

/**
 * What the palette lists for `query`. With nothing typed, the actions and
 * then the most recent chats, as they came. Typed, every word must appear
 * in an item's title or terms; actions come first, then matters, then
 * chats, each best match first and in their own order on a tie, matters and
 * chats cut to a few.
 */
export const filterPalette = (
  items: readonly PaletteItem[],
  query: string,
): PaletteItem[] => {
  const folded = foldText(query.trim());
  const words = folded.split(/\s+/u).filter((word) => word !== "");
  const kinds = ["action", "matter", "chat"] as const;
  return kinds.flatMap((kind) => {
    const ofKind = items.filter((item) => item.kind === kind);
    const limit = kind === "action" ? ofKind.length : PALETTE_ENTITY_LIMIT;
    if (words.length === 0) {
      return kind === "matter" ? [] : ofKind.slice(0, limit);
    }
    return ofKind
      .flatMap((item, index) => {
        const score = scoreOf(item, folded, words);
        return score === null ? [] : [{ index, item, score }];
      })
      .sort(
        (left, right) => left.score - right.score || left.index - right.index,
      )
      .slice(0, limit)
      .map(({ item }) => item);
  });
};

/** The row an arrow key moves to, wrapping at either end. */
export const nextPaletteIndex = (
  index: number,
  direction: -1 | 1,
  count: number,
): number => (count === 0 ? 0 : (index + direction + count) % count);
