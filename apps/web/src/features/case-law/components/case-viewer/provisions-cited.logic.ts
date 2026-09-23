import type { ProvisionReference } from "@stll/legal-ast/provision-reference";

export type ProvisionRow = ProvisionReference & {
  anchor: string;
  jurisdiction: string;
  /** The sentence the reference stands in, as the decision wrote it. */
  sentenceText: string;
  /** Where in the decision the reference stands; two can share an anchor. */
  spanStart: number;
  /** Opening date of the consolidation the reference was made against. */
  versionValidFrom: string | null;
  workCollection: string;
  workEli: string | null;
  workIdentifier: string;
};

/** One mention of a provision in the decision's text. */
type ProvisionOccurrence = Pick<ProvisionRow, "sentenceText" | "spanStart">;

/** A distinct provision, with every place the decision names it. */
export type ProvisionGroup = ProvisionReference &
  Pick<ProvisionRow, "anchor" | "versionValidFrom"> & {
    key: string;
    occurrences: ProvisionOccurrence[];
  };

export type WorkGroup = Pick<ProvisionRow, "jurisdiction" | "workEli"> & {
  key: string;
  provisions: ProvisionGroup[];
  title: string;
};

/**
 * How a work reads in the heading over its provisions.
 *
 * A collection's abbreviation is part of the citation in some sources and a
 * separate column in others, so appending it unconditionally prints it twice
 * (`82/1998 Sb. Sb.`). The identifier is printed in the casing the source
 * gave it: the abbreviation is a proper citation form, not a word to shout.
 */
export const workTitle = ({
  workCollection,
  workIdentifier,
}: Pick<ProvisionRow, "workCollection" | "workIdentifier">): string => {
  const identifier = workIdentifier.trim();
  const collection = workCollection.trim();

  if (collection.length === 0 || identifier.length === 0) {
    return identifier.length === 0 ? collection : identifier;
  }

  const tail = identifier.slice(-collection.length).toLowerCase();
  const precedesTail = identifier.slice(0, -collection.length);
  if (
    tail === collection.toLowerCase() &&
    (precedesTail.length === 0 || /\s$/u.test(precedesTail))
  ) {
    return identifier;
  }

  return `${identifier} ${collection}`;
};

/** Separator no part of a citation can contain, so a key cannot collide. */
const KEY_SEPARATOR = "\u0000";

/**
 * Everything that makes two references the same provision: the designation
 * the decision states, and the consolidation it states it against. A
 * reference to an earlier wording is a different text, so it stays its own
 * row even when the designation matches.
 */
const provisionKey = (row: ProvisionRow): string =>
  [
    row.unit,
    String(row.section),
    row.sectionSuffix ?? "",
    row.subsection ?? "",
    row.letter ?? "",
    row.point ?? "",
    row.sentence ?? "",
    row.openEnded ? "1" : "0",
    row.versionValidFrom ?? "",
    row.anchor,
  ].join(KEY_SEPARATOR);

/**
 * Numbers inside a designation compare as numbers: `§ 10` follows `§ 9`, and
 * `odst. 2` follows `odst. 1`. Anything else compares as text, so a lettered
 * subdivision keeps alphabetical order.
 */
const comparePart = (left: string | null, right: string | null): number => {
  const a = left ?? "";
  const b = right ?? "";
  if (a === b) {
    return 0;
  }
  if (a.length === 0 || b.length === 0) {
    return a.length === 0 ? -1 : 1;
  }

  const numericA = Number.parseInt(a, 10);
  const numericB = Number.parseInt(b, 10);
  if (
    !Number.isNaN(numericA) &&
    !Number.isNaN(numericB) &&
    numericA !== numericB
  ) {
    return numericA - numericB;
  }

  // Code-unit order, not collation: these are citation tokens (`a`, `b`,
  // `1a`), not words, and their order must not move with the reader's locale.
  return a < b ? -1 : 1;
};

const compareProvisions = (left: ProvisionGroup, right: ProvisionGroup) =>
  left.section - right.section ||
  comparePart(left.sectionSuffix, right.sectionSuffix) ||
  comparePart(left.subsection, right.subsection) ||
  comparePart(left.letter, right.letter) ||
  comparePart(left.point, right.point) ||
  comparePart(left.sentence, right.sentence) ||
  Number(left.openEnded) - Number(right.openEnded);

/**
 * The references a decision makes, one row per distinct provision.
 *
 * The read returns one row per mention, because a mention is what carries a
 * passage and a position. A reader asks which provisions the decision
 * applies, not how many times a paragraph repeats one, so the mentions
 * collapse onto their provision and are counted there. Works keep the order
 * the decision first names them in; provisions inside a work read in
 * designation order.
 */
export const groupProvisionsByWork = (
  rows: readonly ProvisionRow[],
): WorkGroup[] => {
  // One entry per work: the group as it will read, and the provisions seen
  // so far keyed by designation. Keeping them together is what lets the
  // second pass sort without asking whether a work has provisions.
  const works = new Map<
    string,
    { byProvision: Map<string, ProvisionGroup>; work: WorkGroup }
  >();

  for (const row of rows) {
    const workKey = `${row.jurisdiction}/${row.workIdentifier}`;
    let entry = works.get(workKey);

    if (entry === undefined) {
      entry = {
        byProvision: new Map<string, ProvisionGroup>(),
        work: {
          jurisdiction: row.jurisdiction,
          key: workKey,
          provisions: [],
          title: workTitle(row),
          workEli: row.workEli,
        },
      };
      works.set(workKey, entry);
    }

    const key = provisionKey(row);
    const occurrence: ProvisionOccurrence = {
      sentenceText: row.sentenceText,
      spanStart: row.spanStart,
    };
    const existing = entry.byProvision.get(key);

    if (existing === undefined) {
      entry.byProvision.set(key, {
        anchor: row.anchor,
        key,
        letter: row.letter,
        occurrences: [occurrence],
        openEnded: row.openEnded,
        point: row.point,
        section: row.section,
        sectionSuffix: row.sectionSuffix,
        sentence: row.sentence,
        subsection: row.subsection,
        unit: row.unit,
        versionValidFrom: row.versionValidFrom,
      });
      continue;
    }

    existing.occurrences.push(occurrence);
  }

  const grouped: WorkGroup[] = [];
  for (const { byProvision, work } of works.values()) {
    work.provisions = [...byProvision.values()].toSorted(compareProvisions);
    grouped.push(work);
  }

  return grouped;
};
