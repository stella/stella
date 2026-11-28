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
  closeNumberParts,
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
  | "excluded"
  /** A tracked change the output keeps sits in the typed label: the label
   *  stays as it is written, change and all. */
  | "trackedChange";

/** `legal`: the level prints every counter in arabic numerals (Word's
 *  legal numbering, `w:isLgl`): `1.1` under article `I.`. */
type LevelFormat = { numFmt: string; lvlText: string; legal?: true };

/** A label restated as a level text, its own counter still unplaced.
 *  `font`: the text face a bullet's mark is a character of. */
export type LabelPattern = LevelFormat & { font?: string };

export type ListLevelFormat = LevelFormat & { ilvl: number; start: number };

/** One paragraph of the output and how it is numbered. */
export type Placement = {
  block: DocxBlock;
  role: HouseStyleRole;
  entry: LabelEntry | null;
  styleId: string | null;
  /** The level that numbers the block, or would. */
  level: ProfileListLevel | null;
  /** The level of the role whose style the block borrows, when its own
   *  role has neither: a spare level that numbers the block takes that
   *  level's indent. */
  borrowedLevel: ProfileListLevel | null;
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
  /** The source's own list the block keeps, where no level of the
   *  template can print its list: the output carries a copy of it. */
  sourceList: { numId: number; ilvl: number } | null;
};

export type OutlineLevels = {
  article: ProfileListLevel | null;
  clauses: (ProfileListLevel | null)[];
};

const LEVEL_PLACEHOLDER = /(%\d)/u;

/** Stands for the paragraph's own counter in a label pattern, until the
 *  level it is counted on is known. */
export const OWN_COUNTER = "\u0001";

const levelKey = ({ abstractNumId, ilvl }: ProfileListLevel): string =>
  `${String(abstractNumId)}:${String(ilvl)}`;

const formatKey = ({ numFmt, lvlText, legal }: LevelFormat): string =>
  `${numFmt}\u0000${lvlText}${legal === true ? "\u0000legal" : ""}`;

const placeholder = (ilvl: number): string => `%${String(ilvl + 1)}`;

const formatAt = (
  { numFmt, lvlText, legal }: LabelPattern,
  ilvl: number,
): LevelFormat => ({
  numFmt,
  lvlText: lvlText.replace(OWN_COUNTER, () => placeholder(ilvl)),
  ...(legal === true ? { legal } : {}),
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

/**
 * The ordinal an automatic label's own counter shows: its last letters or
 * digits, read in the level's format. Null for a format this reader does
 * not count in.
 */
export const labelOrdinalOf = (
  label: string,
  numFmt: string,
): number | null => {
  const counter = /([\p{L}\p{N}]+)[^\p{L}\p{N}]*$/u.exec(label)?.[1];
  if (counter === undefined) {
    return null;
  }
  if (numFmt === "decimal" || numFmt === "decimalZero") {
    return /^\d+$/u.test(counter) ? Number(counter) : null;
  }
  if (numFmt === "lowerLetter" || numFmt === "upperLetter") {
    return letterOrdinal(counter.toLowerCase());
  }
  if (numFmt === "lowerRoman" || numFmt === "upperRoman") {
    return parseRomanNumeral(counter.toUpperCase());
  }
  return null;
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
  // A number typed with blanks between its parts is printed closed up.
  const closed = closeNumberParts(label);
  const words = closed.slice(0, closed.length - designator.length);
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
  legal = false,
): string | null => {
  let rendered = "";
  for (const part of lvlText.split(LEVEL_PLACEHOLDER)) {
    if (!LEVEL_PLACEHOLDER.test(part)) {
      rendered += part;
      continue;
    }
    const ilvl = (digitsValue(part.slice(1)) ?? 0) - 1;
    const numFmt = legal
      ? "decimal"
      : levels.find((level) => level.ilvl === ilvl)?.numFmt;
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

/** Why a label stays text that the source's own list answers: no level of
 *  the template is left to print it, or its label is not one a level text
 *  restates. */
const SOURCE_LIST_REASONS: ReadonlySet<LabelKeptReason> = new Set([
  "noListLevel",
  "formatConflict",
  "unreadable",
]);

/**
 * Keeps the source's own list for every paragraph of a list definition
 * whose automatic labels no level of the template prints, rather than
 * writing those labels as text: the output carries a copy of the list, so
 * the labels stay counted (and stay targets of the source's fields). Only
 * a whole definition moves: one paragraph of it on the template's list
 * would leave the copy counting without it. Bullets keep their marks on
 * the template's levels.
 */
const keepSourceLists = (
  placements: readonly Placement[],
  { loose, excluded }: SourceListOptions,
): Set<number> => {
  const definitionOf = ({ numbering, label }: DocxBlock): number | null =>
    numbering === null ||
    numbering.bullet === true ||
    (label ?? "").trim() === ""
      ? null
      : numbering.abstractNumId;
  const byDefinition = new Map<number, Placement[]>();
  /** Definitions a paragraph of which must stay as it is planned. */
  const held = new Set<number>();
  /** By definition: its paragraphs a level of the template numbers, and
   *  those whose labels would be text. */
  const numberedOf = new Map<number, number>();
  const textOf = new Map<number, number>();
  for (const placement of placements) {
    const definition = definitionOf(placement.block);
    if (definition === null) {
      continue;
    }
    const { numbered, keptReason, entry } = placement;
    // A label the index could not read at all is written as text too.
    const unread = keptReason === null && entry === null;
    if (numbered) {
      numberedOf.set(definition, (numberedOf.get(definition) ?? 0) + 1);
    } else if (
      !(
        unread ||
        (keptReason !== null && SOURCE_LIST_REASONS.has(keptReason))
      ) ||
      excluded.has(placement.block.id)
    ) {
      held.add(definition);
    } else {
      textOf.set(definition, (textOf.get(definition) ?? 0) + 1);
    }
    const group = byDefinition.get(definition);
    if (group === undefined) {
      byDefinition.set(definition, [placement]);
    } else {
      group.push(placement);
    }
  }
  const kept = new Set<number>();
  // A cell paragraph read as no role is placed with its table, its label
  // written as text: it counts in its list all the same.
  for (const block of loose) {
    const definition = definitionOf(block);
    if (definition === null) {
      continue;
    }
    if (excluded.has(block.id)) {
      held.add(definition);
    }
    kept.add(definition);
  }
  for (const definition of byDefinition.keys()) {
    kept.add(definition);
  }
  for (const definition of held) {
    kept.delete(definition);
  }
  // A definition the template's levels number in part moves whole only
  // where most of its labels would be text: its numbered paragraphs (an
  // article on a spare level) then count with the rest in its own list.
  for (const definition of kept) {
    const numbered = numberedOf.get(definition) ?? 0;
    if (numbered > 0 && (textOf.get(definition) ?? 0) <= numbered) {
      kept.delete(definition);
    }
  }
  for (const [definition, group] of byDefinition) {
    if (!kept.has(definition)) {
      continue;
    }
    for (const placement of group) {
      const { numbering } = placement.block;
      if (numbering === null) {
        continue;
      }
      placement.sourceList = { numId: numbering.numId, ilvl: numbering.ilvl };
      placement.numbered = true;
      placement.level = null;
      placement.keptReason = null;
    }
  }
  return kept;
};

type PatchOptions = {
  usedLevels: ReadonlyMap<string, ProfileListLevel>;
  levelsByList: ReadonlyMap<number, readonly ListLevelFormat[]>;
  placements: readonly Placement[];
  standsFor: ReadonlyMap<string, ProfileListLevel>;
};

/** The patches that make each used level of the template print what its
 *  paragraphs need. */
const levelPatchesOf = ({
  usedLevels,
  levelsByList,
  placements,
  standsFor,
}: PatchOptions): TemplatePlanNumberingPatch[] => {
  const patches: TemplatePlanNumberingPatch[] = [];
  for (const [key, level] of usedLevels) {
    const format = levelsByList
      .get(level.abstractNumId)
      ?.find(({ ilvl }) => ilvl === level.ilvl);
    const onLevel = placements.filter(
      (placement) =>
        placement.numbered &&
        placement.level !== null &&
        levelKey(placement.level) === key,
    );
    // A mark that is a character of a text face is that shape only in
    // that face: a level made to print it is set in it.
    const face = onLevel.find(
      (placement) => placement.pattern?.font !== undefined,
    )?.pattern?.font;
    const indent = takenIndent(standsFor.get(key)?.indent, level.indent);
    const stated = indent !== null && Object.keys(indent).length > 0;
    // A level whose own paragraphs all kept their typed label is patched
    // too: the levels below it print its counter in the format counted
    // with here.
    if (
      format !== undefined &&
      (format.numFmt !== level.numFmt ||
        format.lvlText !== level.lvlText ||
        format.legal === true ||
        (onLevel.length > 0 && stated))
    ) {
      patches.push({
        abstractNumId: level.abstractNumId,
        ilvl: level.ilvl,
        ...(format.numFmt === level.numFmt ? {} : { numFmt: format.numFmt }),
        ...(format.lvlText === level.lvlText
          ? {}
          : { lvlText: format.lvlText }),
        ...(face === undefined || format.lvlText === level.lvlText
          ? {}
          : { font: face }),
        ...(stated ? { indent } : {}),
        ...(format.legal === true ? { isLgl: true } : {}),
      });
    }
  }
  return patches;
};

/** The source lists kept: only when the source's numbering is kept. */
const sourceListsOf = (
  mode: NumberingMode,
  placements: readonly Placement[],
  { loose = [], excluded = new Set<string>() }: Partial<SourceListOptions>,
): Set<number> =>
  mode === "keepSource"
    ? keepSourceLists(placements, { loose, excluded })
    : new Set<number>();

type SourceListOptions = {
  /** Labelled paragraphs the plan places without a placement of their own
   *  (cell paragraphs read as no role). */
  loose: readonly DocxBlock[];
  /** Paragraphs an earlier attempt showed the engine will not number. */
  excluded: ReadonlySet<string>;
};

type Vote = { pattern: LabelPattern; n: number };

/** Whether a pattern prints the counter of a level above its own. */
const namesLevelAbove = ({ lvlText }: LabelPattern): boolean => {
  const own = lvlText.indexOf(OWN_COUNTER);
  return own !== -1 && /%\d/u.test(lvlText.slice(0, own));
};

/** The format each role level prints: the one most of its paragraphs need. */
const voteLevelPatterns = (
  candidates: readonly Placement[],
): Map<string, LabelPattern> => {
  // A heading whose counter the labels under it print (`I.` of `I.1.`)
  // carries their votes too: given up to another format, it would take
  // them along.
  const dependents = new Map<string, number>();
  for (const { entry, pattern } of candidates) {
    const article = entry?.articleBlockId ?? null;
    if (
      article !== null &&
      article !== entry?.blockId &&
      pattern !== null &&
      namesLevelAbove(pattern)
    ) {
      dependents.set(article, (dependents.get(article) ?? 0) + 1);
    }
  }
  const votes = new Map<string, Map<string, Vote>>();
  for (const { level, pattern, block } of candidates) {
    if (level === null || pattern === null) {
      continue;
    }
    const ofLevel = votes.get(levelKey(level)) ?? new Map<string, Vote>();
    const vote = ofLevel.get(formatKey(pattern)) ?? { pattern, n: 0 };
    vote.n += 1 + (dependents.get(block.id) ?? 0);
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
/** The deepest level a pattern prints the counter of besides its own; -1
 *  for none. */
const deepestNamedLevel = ({ lvlText }: LabelPattern): number =>
  Math.max(
    -1,
    ...[...lvlText.matchAll(/%(\d)/gu)].map((match) => Number(match[1]) - 1),
  );

/**
 * The level a group of displaced paragraphs takes. A bullet counts nothing:
 * it takes a level outside the outline list while there is one, and leaves
 * the outline's to formats that count. A level that prints the counter of
 * another must stand below it: in a list a level restarts only when one
 * above it counts.
 */
const freshLevelFor = (
  pattern: LabelPattern | null,
  spare: ProfileListLevel[],
  marks: ProfileListLevel[],
): ProfileListLevel | undefined => {
  if (pattern?.numFmt === "bullet") {
    return marks.shift() ?? spare.shift();
  }
  return takeBelow(spare, pattern === null ? -1 : deepestNamedLevel(pattern));
};

/** Takes the first spare level below `above` out of `spare`. */
const takeBelow = (
  spare: ProfileListLevel[],
  above: number,
): ProfileListLevel | undefined => {
  const at = spare.findIndex(({ ilvl }) => ilvl > above);
  return at === -1 ? undefined : spare.splice(at, 1)[0];
};

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
    // Paragraphs that print one format at different indents (bullets
    // under a clause and bullets under an item) take a level each.
    const key = `${formatKey(pattern)}\u0000${String(
      level === null ? (placement.borrowedLevel?.indent.left ?? "") : "",
    )}`;
    const group = displaced.get(key);
    if (group === undefined) {
      displaced.set(key, [placement]);
    } else {
      group.push(placement);
    }
  }
  const spare = [...spareLevels];
  /** The spare level that prints a format: where the levels run out, a
   *  later group of the same format joins it rather than lose its mark. */
  const levelByFormat = new Map<string, ProfileListLevel>();
  const marks = [...markLevels];
  for (const group of [...displaced.values()].toSorted(
    (left, right) => right.length - left.length,
  )) {
    const first = group.at(0);
    const pattern = first?.pattern ?? null;
    const format = pattern === null ? "" : formatKey(pattern);
    const fresh = freshLevelFor(pattern, spare, marks);
    const level = fresh ?? levelByFormat.get(format);
    if (fresh !== undefined) {
      levelByFormat.set(format, fresh);
    }
    if (fresh !== undefined && pattern !== null) {
      chosen.set(levelKey(fresh), pattern);
    }
    const origin = first?.level ?? first?.borrowedLevel ?? null;
    if (fresh !== undefined && origin !== null) {
      standsFor.set(levelKey(fresh), origin);
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
        // A number typed with blanks between its parts is printed closed up.
        renderLabel(format.lvlText, next, levels, format.legal === true) !==
          (placement.sourceLabel === null
            ? null
            : closeNumberParts(placement.sourceLabel)))
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
  { numbered, level, counters, sourceList, block }: Placement,
  levelsByList: ReadonlyMap<number, readonly ListLevelFormat[]>,
): string | null => {
  // The source's own list prints what it prints in the source.
  if (numbered && sourceList !== null) {
    return block.label?.trim() ?? null;
  }
  const levels =
    numbered && level !== null
      ? levelsByList.get(level.abstractNumId)
      : undefined;
  const format = levels?.find(({ ilvl }) => ilvl === level?.ilvl);
  return levels === undefined || format === undefined
    ? null
    : renderLabel(format.lvlText, counters, levels, format.legal === true);
};

type Numbered = {
  patches: TemplatePlanNumberingPatch[];
  /** The levels each list counts with, patches applied, by list
   *  definition. */
  levelsByList: Map<number, ListLevelFormat[]>;
  /** The source's list definitions the output keeps, each paragraph of
   *  them counted in a copy of its own list. */
  sourceLists: ReadonlySet<number>;
};

type NumberOptions = {
  placements: readonly Placement[];
  mode: NumberingMode;
  spareLevels: readonly ProfileListLevel[];
  /** Levels outside the outline list, for marks that count nothing. */
  markLevels?: readonly ProfileListLevel[] | undefined;
} & Partial<SourceListOptions>;

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
  ...sourceOptions
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
    const { numFmt, lvlText, legal }: LevelFormat =
      pattern === undefined ? level : formatAt(pattern, level.ilvl);
    const format = {
      ilvl: level.ilvl,
      start: level.start,
      numFmt,
      lvlText,
      ...(legal === true ? { legal } : {}),
    };
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

  const sourceLists = sourceListsOf(mode, placements, sourceOptions);

  const patches = levelPatchesOf({
    usedLevels,
    levelsByList,
    placements,
    standsFor,
  });
  return { patches, levelsByList, sourceLists };
};

/** The languages of a document and of the template it is formatted onto,
 *  as the caller knows them (ISO 639-1 codes). */
export type PlanLanguages = { document: string; template: readonly string[] };

const LABEL_LANGUAGES = ["cs", "sk", "en", "de"] as const;

type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

/** How the firm's templates print an article's label, by language: the
 *  word in front of the number and what follows the number. */
const ARTICLE_LABELS = {
  cs: { word: "Čl.", after: "" },
  sk: { word: "Čl.", after: "" },
  en: { word: "Art.", after: "" },
  de: { word: "Art.", after: "." },
} as const satisfies Record<LabelLanguage, { word: string; after: string }>;

const isLabelLanguage = (language: string): language is LabelLanguage =>
  LABEL_LANGUAGES.some((known) => known === language);

const ARTICLE_LEVEL =
  /^(?<word>Čl\.|Art\.)(?<blank>[ \u00A0]+)(?<counter>%\d)(?<after>\.?)$/u;

type LanguageOptions = {
  languages: PlanLanguages;
  patches: TemplatePlanNumberingPatch[];
  levelsByList: Map<number, ListLevelFormat[]>;
};

/**
 * Puts the word a level of the template prints in front of an article's
 * number into the document's language, where the template is in another:
 * a contract in English renumbered onto a Czech template reads `Art. 1`,
 * not `Čl. 1`. For the template's own scheme only; a document that keeps
 * its numbers keeps its words. Returns how many levels were changed.
 */
export const levelsInLanguage = ({
  languages: { document, template },
  patches,
  levelsByList,
}: LanguageOptions): number => {
  if (!isLabelLanguage(document) || template.includes(document)) {
    return 0;
  }
  const own = ARTICLE_LABELS[document];
  let changed = 0;
  for (const [abstractNumId, levels] of levelsByList) {
    for (const level of levels) {
      const parts = ARTICLE_LEVEL.exec(level.lvlText)?.groups;
      const lvlText =
        parts === undefined
          ? level.lvlText
          : `${own.word}${parts["blank"] ?? " "}${parts["counter"] ?? ""}${own.after}`;
      if (lvlText === level.lvlText) {
        continue;
      }
      level.lvlText = lvlText;
      changed += 1;
      const patch = patches.find(
        (candidate) =>
          candidate.abstractNumId === abstractNumId &&
          candidate.ilvl === level.ilvl,
      );
      if (patch === undefined) {
        patches.push({ abstractNumId, ilvl: level.ilvl, lvlText });
      } else {
        patch.lvlText = lvlText;
      }
    }
  }
  return changed;
};
