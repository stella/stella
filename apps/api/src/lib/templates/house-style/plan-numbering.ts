// Which labelled paragraphs join the template's lists, and what those lists
// must print for the output to show the source's designators.
//
// A label is restated as the level text that prints it (`Článek IV.` is
// `Článek %1.` in roman numerals). Each level prints one such format, the
// one most of its paragraphs need; a format the roles' levels do not print
// takes a spare level. The lists are then counted the way the engine counts
// them, and a paragraph whose rendered label would differ from the source's
// keeps its label as text.

import { panic } from "better-result";

import { parseRomanNumeral } from "@stll/api-contract/magyar-kozlony-designation";

import {
  digitsValue,
  formatNumeral,
  letterOrdinal,
} from "@/api/lib/templates/house-style/designators";
import type { DesignatorNumeral } from "@/api/lib/templates/house-style/designators";
import type {
  DocxBlock,
  TemplatePlanNumberingPatch,
} from "@/api/lib/templates/house-style/folio-contract";
import type { LabelEntry } from "@/api/lib/templates/house-style/label-index";
import type { HouseStyleRole } from "@/api/lib/templates/house-style/role-proposer";
import type { ProfileListLevel } from "@/api/lib/templates/house-style/template-profile";

export type NumberingMode = "keepSource" | "houseScheme";

export type LabelKeptReason =
  /** The level prints another format for most of its paragraphs. */
  | "formatConflict"
  /** The engine strips only what it recognises as a label. */
  | "notStrippable"
  /** The template numbers no level for the role. */
  | "noListLevel"
  /** The label is not one this reader can restate as a level text. */
  | "unreadable"
  /** An earlier attempt showed the engine will not number the block. */
  | "excluded";

type LevelFormat = { numFmt: string; lvlText: string };

/** A label restated as a level text, its own counter still unplaced. */
type LabelPattern = LevelFormat;

export type ListLevelFormat = LevelFormat & { ilvl: number; start: number };

/** One paragraph of the output and how it is numbered. */
export type Placement = {
  block: DocxBlock;
  role: HouseStyleRole;
  entry: LabelEntry | null;
  styleId: string | null;
  /** The level that numbers the block, or would. */
  level: ProfileListLevel | null;
  /** The label as the source prints it, without the blanks around it. */
  sourceLabel: string | null;
  /** What a level must print for the block to keep its label. */
  pattern: LabelPattern | null;
  ordinal: number | null;
  numbered: boolean;
  restartFrom: number | null;
  /** The list instance the block is counted in; null for the template's. */
  group: string | null;
  /** The list's counters once the block is counted, down to its level. */
  counters: number[];
  keptReason: LabelKeptReason | null;
};

export type OutlineLevels = {
  article: ProfileListLevel | null;
  clauses: (ProfileListLevel | null)[];
};

const LEVEL_PLACEHOLDER = /(%\d)/u;

/** Stands for the paragraph's own counter in a label pattern, until the
 *  level it is counted on is known. */
const OWN_COUNTER = "\u0001";

const levelKey = ({ abstractNumId, ilvl }: ProfileListLevel): string =>
  `${String(abstractNumId)}:${String(ilvl)}`;

const formatKey = ({ numFmt, lvlText }: LevelFormat): string =>
  `${numFmt}\u0000${lvlText}`;

const placeholder = (ilvl: number): string => `%${String(ilvl + 1)}`;

const formatAt = (
  { numFmt, lvlText }: LabelPattern,
  ilvl: number,
): LevelFormat => ({
  numFmt,
  lvlText: lvlText.replace(OWN_COUNTER, () => placeholder(ilvl)),
});

const NUMERAL_FORMAT = {
  decimal: "decimal",
  upperRoman: "upperRoman",
  lowerRoman: "lowerRoman",
  upperLetter: "upperLetter",
  lowerLetter: "lowerLetter",
  upperAmbiguous: null,
  lowerAmbiguous: null,
} as const satisfies Record<DesignatorNumeral, string | null>;

const isUpper = (numeral: DesignatorNumeral): boolean =>
  numeral.startsWith("upper");

/** The number format a level must count in to print the entry's own
 *  designator. A single `i` or `V` is read by the level it stands on. */
const numFmtOf = ({ level, shape: { numeral } }: LabelEntry): string | null => {
  switch (level) {
    case "clause":
      return numeral === "decimal" ? "decimal" : null;
    case "letter":
      return isUpper(numeral) ? "upperLetter" : "lowerLetter";
    case "roman":
      return isUpper(numeral) ? "upperRoman" : "lowerRoman";
    case "article":
    case "annex": {
      const roman = isUpper(numeral) ? "upperRoman" : "lowerRoman";
      return NUMERAL_FORMAT[numeral] ?? roman;
    }
    case "recital": {
      const letter = isUpper(numeral) ? "upperLetter" : "lowerLetter";
      return NUMERAL_FORMAT[numeral] ?? letter;
    }
    default: {
      level satisfies never;
      return panic("Unhandled level");
    }
  }
};

/** The ordinal a level must show to print the entry's designator. */
export const ordinalOf = (entry: LabelEntry, numFmt: string): number | null => {
  if (entry.level === "clause" || numFmt === "decimal") {
    return entry.ordinal ?? entry.shape.path?.at(-1) ?? null;
  }
  return numFmt.endsWith("Letter")
    ? letterOrdinal(entry.core)
    : parseRomanNumeral(entry.shape.core.toUpperCase());
};

/** The counters a clause's number names above its own: `5.1.2` under
 *  article 5 is `%1.%2.` in front of its own; null when a level it names
 *  is one the template lacks, or counts in another list than its articles. */
const clauseParents = (
  entry: LabelEntry,
  { article, clauses }: OutlineLevels,
): string[] | null => {
  const { path } = entry.shape;
  const depth = entry.clausePath.length;
  const above = clauses.slice(0, depth - 1);
  if (path === null) {
    return null;
  }
  const withArticle =
    path.length === depth + 1 && path.at(0) === entry.articleOrdinal;
  if (
    depth < 1 ||
    above.length !== depth - 1 ||
    (!withArticle && path.length !== depth)
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const level of withArticle ? [article, ...above] : above) {
    if (
      level === null ||
      (article !== null && level.abstractNumId !== article.abstractNumId)
    ) {
      return null;
    }
    parts.push(placeholder(level.ilvl));
  }
  return parts;
};

/** Restates a label as the level text that prints it: `Článek IV.` is
 *  `Článek %1.`, and `5.1.2` under article 5 is `%1.%2.%3`. */
export const patternOf = (
  entry: LabelEntry,
  label: string,
  outline: OutlineLevels,
): LabelPattern | null => {
  const { shape } = entry;
  const numFmt = numFmtOf(entry);
  if (numFmt === null || shape.length !== label.length || label.includes("%")) {
    return null;
  }
  const closing = `${shape.close}${shape.period ? "." : ""}`;
  const designator = `${shape.open}${shape.core}${closing}`;
  const words = label.slice(0, label.length - designator.length);
  const parents = entry.level === "clause" ? clauseParents(entry, outline) : [];
  if (parents === null) {
    return null;
  }
  const counters = [...parents, OWN_COUNTER].join(".");
  return { numFmt, lvlText: `${words}${shape.open}${counters}${closing}` };
};

/** Renders a level text over the list's counters; null when a level it
 *  names has no format this reader can print. */
const renderLabel = (
  lvlText: string,
  counters: readonly number[],
  levels: readonly ListLevelFormat[],
): string | null => {
  let rendered = "";
  for (const part of lvlText.split(LEVEL_PLACEHOLDER)) {
    if (!LEVEL_PLACEHOLDER.test(part)) {
      rendered += part;
      continue;
    }
    const ilvl = (digitsValue(part.slice(1)) ?? 0) - 1;
    const numFmt = levels.find((level) => level.ilvl === ilvl)?.numFmt;
    const numeral = formatNumeral(counters[ilvl] ?? 1, numFmt ?? "decimal");
    if (numeral === null) {
      return null;
    }
    rendered += numeral;
  }
  return rendered;
};

const keepLabel = (placement: Placement, reason: LabelKeptReason): void => {
  placement.numbered = false;
  placement.keptReason = reason;
};

type Vote = { pattern: LabelPattern; n: number };

/** The format each role level prints: the one most of its paragraphs need. */
const voteLevelPatterns = (
  candidates: readonly Placement[],
): Map<string, LabelPattern> => {
  const votes = new Map<string, Map<string, Vote>>();
  for (const { level, pattern } of candidates) {
    if (level === null || pattern === null) {
      continue;
    }
    const ofLevel = votes.get(levelKey(level)) ?? new Map<string, Vote>();
    const vote = ofLevel.get(formatKey(pattern)) ?? { pattern, n: 0 };
    vote.n += 1;
    ofLevel.set(formatKey(pattern), vote);
    votes.set(levelKey(level), ofLevel);
  }
  const chosen = new Map<string, LabelPattern>();
  for (const [key, ofLevel] of votes) {
    const [winner] = [...ofLevel.values()].toSorted(
      (left, right) => right.n - left.n,
    );
    if (winner !== undefined) {
      chosen.set(key, winner.pattern);
    }
  }
  return chosen;
};

/**
 * A label its role's level does not print (the level prints another format,
 * or the template numbers no level for the role) takes a spare level of the
 * outline, patched to print it: the format most paragraphs need first, while
 * spare levels last.
 */
const assignSpareLevels = (
  candidates: readonly Placement[],
  chosen: Map<string, LabelPattern>,
  spareLevels: readonly ProfileListLevel[],
  markLevels: readonly ProfileListLevel[],
): Map<string, ProfileListLevel> => {
  /** The role level whose paragraphs a spare level takes over, by spare
   *  level: they keep that level's indent. */
  const standsFor = new Map<string, ProfileListLevel>();
  const displaced = new Map<string, Placement[]>();
  for (const placement of candidates) {
    const { level, pattern } = placement;
    if (pattern === null) {
      keepLabel(placement, "unreadable");
      continue;
    }
    const wanted = level === null ? undefined : chosen.get(levelKey(level));
    if (wanted !== undefined && formatKey(pattern) === formatKey(wanted)) {
      continue;
    }
    const group = displaced.get(formatKey(pattern));
    if (group === undefined) {
      displaced.set(formatKey(pattern), [placement]);
    } else {
      group.push(placement);
    }
  }
  const spare = [...spareLevels];
  const marks = [...markLevels];
  for (const group of [...displaced.values()].toSorted(
    (left, right) => right.length - left.length,
  )) {
    const first = group.at(0);
    const pattern = first?.pattern ?? null;
    // A bullet counts nothing: it takes a level outside the outline list
    // while there is one, and leaves the outline's to formats that count.
    const level =
      pattern?.numFmt === "bullet"
        ? (marks.shift() ?? spare.shift())
        : spare.shift();
    if (level !== undefined && pattern !== null) {
      chosen.set(levelKey(level), pattern);
    }
    if (level !== undefined && first !== undefined && first.level !== null) {
      standsFor.set(levelKey(level), first.level);
    }
    for (const placement of group) {
      if (level === undefined) {
        keepLabel(
          placement,
          placement.level === null ? "noListLevel" : "formatConflict",
        );
      } else {
        placement.level = level;
      }
    }
  }
  return standsFor;
};

type Instance = {
  group: string | null;
  counters: (number | undefined)[];
  /** The levels a paragraph of this run has counted; a level above the
   *  first paragraph of a list only shows its start. */
  counted: ReadonlySet<number>;
  /** The start this instance gives a level in place of the list's. */
  starts: Map<number, number>;
};

type CountOptions = {
  placements: readonly Placement[];
  levelsByList: ReadonlyMap<number, ListLevelFormat[]>;
  mode: NumberingMode;
};

/**
 * Counts the lists once, in document order. The engine counts per list
 * instance: an instance counts a level on from its last number, or from the
 * level's start after a level above it was counted, and an instance met for
 * the first time takes the numbers of the levels above from the paragraph
 * before it. So a paragraph whose number is not the next one opens an
 * instance that starts its level there, and the paragraphs after it stay in
 * that instance. Returns the first paragraph whose label would not come out
 * as the source prints it, or null when every one does.
 */
const countLists = ({
  placements,
  levelsByList,
  mode,
}: CountOptions): Placement | null => {
  const currentByList = new Map<number, Instance>();
  let opened = 0;
  for (const placement of placements) {
    const { level, numbered } = placement;
    if (!numbered || level === null) {
      continue;
    }
    const levels =
      levelsByList.get(level.abstractNumId) ??
      panic("A numbered paragraph's list has no levels");
    const current: Instance = currentByList.get(level.abstractNumId) ?? {
      group: null,
      counters: [],
      counted: new Set(),
      starts: new Map(),
    };
    const own = current.counters[level.ilvl];
    const expected =
      own === undefined
        ? (current.starts.get(level.ilvl) ?? level.start)
        : own + 1;
    // The house scheme counts on from the last paragraph of the level. A
    // level that so far only showed its start under a deeper paragraph has
    // no such paragraph: its first one takes the start.
    const following = current.counted.has(level.ilvl) ? expected : level.start;
    const ordinal =
      mode === "keepSource" ? (placement.ordinal ?? expected) : following;
    const counted = new Set(
      [...current.counted].filter((ilvl) => ilvl < level.ilvl),
    ).add(level.ilvl);
    const instance: Instance =
      ordinal === expected
        ? { ...current, counted }
        : {
            group: `list${String(level.abstractNumId)}-${String(opened + 1)}`,
            counters: [],
            counted,
            starts: new Map([[level.ilvl, ordinal]]),
          };
    if (ordinal !== expected) {
      opened += 1;
    }
    // Counting a level clears the levels below it; a level above it that
    // was never counted shows its start.
    const next = Array.from(
      { length: level.ilvl },
      (_unused, ilvl) =>
        current.counters[ilvl] ??
        levels.find((candidate) => candidate.ilvl === ilvl)?.start ??
        1,
    );
    next.push(ordinal);
    const format = levels.find((candidate) => candidate.ilvl === level.ilvl);
    if (
      mode === "keepSource" &&
      (format === undefined ||
        renderLabel(format.lvlText, next, levels) !== placement.sourceLabel)
    ) {
      return placement;
    }
    placement.restartFrom = ordinal === expected ? null : ordinal;
    placement.group = instance.group;
    placement.counters = next;
    instance.counters = next;
    currentByList.set(level.abstractNumId, instance);
  }
  return null;
};

type LevelIndent = ProfileListLevel["indent"];

/**
 * The indent a spare level is patched with. It lies deeper than the level
 * it stands in for and would indent its paragraphs further, so it takes
 * that level's indent; null where the two agree already. A level indents
 * its first line one way: hanging, or first line.
 */
const takenIndent = (
  origin: LevelIndent | undefined,
  own: LevelIndent,
): NonNullable<TemplatePlanNumberingPatch["indent"]> | null => {
  if (
    origin === undefined ||
    (origin.left === own.left &&
      origin.hanging === own.hanging &&
      origin.firstLine === own.firstLine)
  ) {
    return null;
  }
  const firstLine = origin.hanging === null ? origin.firstLine : null;
  return {
    ...(origin.left === null ? {} : { left: origin.left }),
    ...(origin.hanging === null ? {} : { hanging: origin.hanging }),
    ...(firstLine === null ? {} : { firstLine }),
  };
};

/** The label the plan's list prints for a paragraph; null when the
 *  paragraph joins no list. */
export const plannedLabelOf = (
  { numbered, level, counters }: Placement,
  levelsByList: ReadonlyMap<number, readonly ListLevelFormat[]>,
): string | null => {
  const levels =
    numbered && level !== null
      ? levelsByList.get(level.abstractNumId)
      : undefined;
  const format = levels?.find(({ ilvl }) => ilvl === level?.ilvl);
  return levels === undefined || format === undefined
    ? null
    : renderLabel(format.lvlText, counters, levels);
};

type Numbered = {
  patches: TemplatePlanNumberingPatch[];
  /** The levels each list counts with, patches applied, by list
   *  definition. */
  levelsByList: Map<number, ListLevelFormat[]>;
};

type NumberOptions = {
  placements: readonly Placement[];
  mode: NumberingMode;
  spareLevels: readonly ProfileListLevel[];
  /** Levels outside the outline list, for marks that count nothing. */
  markLevels?: readonly ProfileListLevel[];
};

/**
 * Decides which of the placements that ask for a number get one, on which
 * level and in which list instance, and which levels the output patches.
 * A placement that does not is marked with the reason its label stays.
 */
export const numberPlacements = ({
  placements,
  mode,
  spareLevels,
  markLevels = [],
}: NumberOptions): Numbered => {
  const candidates = placements.filter(({ numbered }) => numbered);
  const chosen =
    mode === "keepSource"
      ? voteLevelPatterns(candidates)
      : new Map<string, LabelPattern>();
  // The house scheme numbers the roles' own levels. A template that has
  // no level for bullets says nothing about them: there a bulleted
  // paragraph keeps its mark on a spare level, as it does when the source's
  // numbering is kept.
  const standsFor = assignSpareLevels(
    mode === "keepSource"
      ? candidates
      : candidates.filter(
          ({ level, pattern }) =>
            level === null && pattern?.numFmt === "bullet",
        ),
    chosen,
    spareLevels,
    markLevels,
  );
  const usedLevels = new Map<string, ProfileListLevel>();
  for (const placement of candidates) {
    // The house scheme numbers the roles' own levels only.
    if (placement.numbered && placement.level === null) {
      keepLabel(placement, "noListLevel");
    }
    if (placement.numbered && placement.level !== null) {
      usedLevels.set(levelKey(placement.level), placement.level);
    }
  }
  const levelsByList = new Map<number, ListLevelFormat[]>();
  for (const [key, level] of usedLevels) {
    const pattern = chosen.get(key);
    const { numFmt, lvlText } =
      pattern === undefined ? level : formatAt(pattern, level.ilvl);
    const format = { ilvl: level.ilvl, start: level.start, numFmt, lvlText };
    const levels = levelsByList.get(level.abstractNumId);
    if (levels === undefined) {
      levelsByList.set(level.abstractNumId, [format]);
    } else {
      levels.push(format);
    }
  }

  // Taking a paragraph out changes the count of those after it.
  let mismatch = countLists({ placements, levelsByList, mode });
  while (mismatch !== null) {
    keepLabel(mismatch, "formatConflict");
    mismatch = countLists({ placements, levelsByList, mode });
  }

  const patches: TemplatePlanNumberingPatch[] = [];
  for (const [key, level] of usedLevels) {
    const format = levelsByList
      .get(level.abstractNumId)
      ?.find(({ ilvl }) => ilvl === level.ilvl);
    const used = placements.some(
      (placement) =>
        placement.numbered &&
        placement.level !== null &&
        levelKey(placement.level) === key,
    );
    const indent = takenIndent(standsFor.get(key)?.indent, level.indent);
    const stated = indent !== null && Object.keys(indent).length > 0;
    // A level whose own paragraphs all kept their typed label is patched
    // too: the levels below it print its counter in the format counted
    // with here.
    if (
      format !== undefined &&
      (format.numFmt !== level.numFmt ||
        format.lvlText !== level.lvlText ||
        (used && stated))
    ) {
      patches.push({
        abstractNumId: level.abstractNumId,
        ilvl: level.ilvl,
        ...(format.numFmt === level.numFmt ? {} : { numFmt: format.numFmt }),
        ...(format.lvlText === level.lvlText
          ? {}
          : { lvlText: format.lvlText }),
        ...(stated ? { indent } : {}),
      });
    }
  }
  return { patches, levelsByList };
};
