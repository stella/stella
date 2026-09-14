import { stripDiacritics } from "@stll/text-normalize";
import { OUTLINE_EMPHASIS, type OutlineItem } from "@stll/ui/outline-rail";

import {
  parseProvisionDesignation,
  type ProvisionUnit,
} from "@/components/legal-reader/reader-outline";

/**
 * What the rail's jump field makes of what the reader typed.
 *
 * A code's outline is thousands of rows, and the one someone means is the one
 * they named. Plain substring matching buries it: `10` lists § 10 between
 * § 100, § 105 and § 210. The matches are therefore ranked — the provision the
 * query names, then the provisions whose number it begins, then everything
 * stating it anywhere — so the field's selection starts on the answer and
 * Enter goes there.
 */

/** Best first; `RANK_ORDER` is what the list is sorted by. */
const OUTLINE_MATCH_RANKS = {
  /** The query names this provision outright: `§ 10`, or `10`, is § 10. */
  designation: "designation",
  /** The provision's number begins with the one typed: `10` reaches § 105. */
  designationPrefix: "designationPrefix",
  /** The query appears somewhere in the entry's label, title or range. */
  text: "text",
} as const;

type OutlineMatchRank =
  (typeof OUTLINE_MATCH_RANKS)[keyof typeof OUTLINE_MATCH_RANKS];

const RANK_ORDER = {
  designation: 0,
  designationPrefix: 1,
  text: 2,
} as const satisfies Record<OutlineMatchRank, number>;

type OutlineMatch = {
  item: OutlineItem;
  rank: OutlineMatchRank;
};

export type OutlineMatches = {
  /** The entry the query names outright, when it names one. */
  exactId: string | null;
  /** Ranked best first; document order breaks a tie inside a rank. */
  matches: readonly OutlineMatch[];
};

/**
 * A query addressing one provision. `unit` is undefined when the reader typed
 * a bare number: an act numbers its provisions one way, so `10` names § 10 in
 * a Czech act and Art. 10 in a Polish one without the reader spelling out
 * which marker this publisher uses.
 */
type OutlineQuery =
  | { type: "empty" }
  | { number: string; text: string; type: "provision"; unit?: ProvisionUnit }
  | { text: string; type: "text" };

/** Digits plus any letter suffix, as an act prints them: `10`, `265b`. */
const BARE_NUMBER_RE = /^\d+[a-z]*$/iu;

/** Fold used for every comparison here: diacritics and case are not meant. */
const foldForMatch = (value: string): string =>
  stripDiacritics(value).toLowerCase();

const parseOutlineQuery = (raw: string): OutlineQuery => {
  const text = raw.trim();

  if (text.length === 0) {
    return { type: "empty" };
  }

  const designation = parseProvisionDesignation(text);

  if (designation !== null) {
    return {
      number: designation.number,
      text,
      type: "provision",
      unit: designation.unit,
    };
  }

  return BARE_NUMBER_RE.test(text)
    ? { number: text, text, type: "provision" }
    : { text, type: "text" };
};

/** How closely the entry's own designation answers the query, if at all. */
const designationRank = (
  item: OutlineItem,
  query: OutlineQuery,
): OutlineMatchRank | null => {
  if (query.type !== "provision") {
    return null;
  }

  const designation = parseProvisionDesignation(item.label);

  if (
    designation === null ||
    (query.unit !== undefined && designation.unit !== query.unit)
  ) {
    return null;
  }

  const number = foldForMatch(designation.number);
  const wanted = foldForMatch(query.number);

  if (number === wanted) {
    return OUTLINE_MATCH_RANKS.designation;
  }

  return number.startsWith(wanted)
    ? OUTLINE_MATCH_RANKS.designationPrefix
    : null;
};

const rankOf = (
  item: OutlineItem,
  query: OutlineQuery,
): OutlineMatchRank | null => {
  if (query.type === "empty") {
    return null;
  }

  const byDesignation = designationRank(item, query);

  if (byDesignation !== null) {
    return byDesignation;
  }

  const haystack = foldForMatch(
    `${item.label} ${item.title ?? ""} ${item.meta ?? ""}`,
  );

  return haystack.includes(foldForMatch(query.text))
    ? OUTLINE_MATCH_RANKS.text
    : null;
};

/**
 * The outline entries answering `rawQuery`, best first. An empty query
 * matches nothing: the caller then shows the outline as the act states it,
 * rather than a result list restating every row.
 */
export const rankOutlineMatches = (
  items: readonly OutlineItem[],
  rawQuery: string,
): OutlineMatches => {
  const query = parseOutlineQuery(rawQuery);
  const matches: OutlineMatch[] = [];

  for (const item of items) {
    const rank = rankOf(item, query);

    if (rank !== null) {
      matches.push({ item, rank });
    }
  }

  // A stable sort leaves document order inside each rank, which is the order
  // the act itself is read in.
  matches.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);

  return {
    exactId:
      matches.find((match) => match.rank === OUTLINE_MATCH_RANKS.designation)
        ?.item.id ?? null,
    matches,
  };
};

/**
 * Where the selection actually sits, in a list that changes under it: the
 * reader edits the query, or navigates to another consolidation of the same
 * act while the field keeps what they typed. A shorter list then selects its
 * last entry rather than nothing, so the highlight never goes missing and
 * Enter always has somewhere to go.
 */
export const clampSelectedIndex = ({
  count,
  index,
}: {
  count: number;
  index: number;
}): number => Math.max(0, Math.min(index, count - 1));

/**
 * The ranked matches as rail entries: one flat list in rank order, with the
 * near-misses stepped back whenever the query named an entry outright.
 *
 * Flat because the ranking is the order now. Nesting the results back under
 * their containers would restate document order and put the named provision
 * wherever the act happens to hold it, which is the burial this ranking
 * exists to undo.
 */
export const outlineMatchItems = ({
  exactId,
  matches,
}: OutlineMatches): OutlineItem[] =>
  matches.map(({ item, rank }) => ({
    ...item,
    level: 0,
    ...(exactId !== null && rank !== OUTLINE_MATCH_RANKS.designation
      ? { emphasis: OUTLINE_EMPHASIS.secondary }
      : {}),
  }));
