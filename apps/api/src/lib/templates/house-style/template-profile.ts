// What a Word template means: which of its styles and list levels stand for
// an article heading, a clause, a letter item; which of its blocks are kept
// around a document (a letterhead, a table of contents) and which are sample
// text; which fields must not stay live. Inferred from the template alone,
// by rule, with a confidence per reading, so a person can confirm it once and
// every later document is placed the same way.

import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type {
  DocxBlock,
  TemplateInspection,
  TemplateLevelIndent,
  TemplateStyle,
} from "@/api/lib/templates/house-style/folio-contract";
import {
  HEAD_FIELDS,
  readFieldName,
} from "@/api/lib/templates/house-style/head-fields";
import type { HeadField } from "@/api/lib/templates/house-style/head-fields";
import { HOUSE_STYLE_ROLES } from "@/api/lib/templates/house-style/role-proposer";
import type { HouseStyleRole } from "@/api/lib/templates/house-style/role-proposer";

const ROLE_EVIDENCE = ["styleName", "sample", "listLevel", "fallback"] as const;

type RoleEvidence = (typeof ROLE_EVIDENCE)[number];

/** The list level that numbers a role, with the format it prints in. */
export type ProfileListLevel = {
  numId: number;
  ilvl: number;
  abstractNumId: number;
  numFmt: string;
  lvlText: string;
  start: number;
  /** The indent the level gives its paragraphs. */
  indent: TemplateLevelIndent;
};

export type ProfileRoleTarget = {
  styleId: string;
  /** The paragraph alignment the style states; null when it states none. */
  alignment: string | null;
  /** Null for a role the template does not number. */
  numbering: ProfileListLevel | null;
  /** The left indent the style gives, in twentieths of a point, and the
   *  size of its text in half-points; null where the template states
   *  none. Both absent from a profile made before they were read. */
  indentLeft?: number | null;
  size?: number | null;
  confidence: number;
  evidence: RoleEvidence[];
};

/** How a heading and its title share a paragraph in the template's sample. */
type HeadingJoin = "sameLine" | "lineBreak";

/**
 * Something in the template a firm may want to mend at its source. The
 * output is right either way; the finding says what the template itself
 * does when a document is made from it by hand.
 *
 * `numberDrawnAsPicture`, `textDrawnAsPicture`: the run properties of a
 * list level, or of a style or the document defaults, carry a 3-D scene
 * that shows nothing. A word processor draws such text as a picture: in an
 * exported document the number or the text cannot be found, copied or read
 * aloud. Clearing the 3-D format on the level or style mends it.
 *
 * `levelSetApart`: the style of a numbered level states bold, or a font
 * size, that the styles of the other levels and of the body text do not.
 * Under plain siblings every paragraph of that level reads as a heading.
 * The output places the role in `insteadStyleId`, the style of the nearest
 * level that looks like the rest, on the level's own place in the list, so
 * number and indent stay; a profile with `levelLooks: "asTemplate"` keeps
 * the template's style. Giving the style the look of its siblings mends it.
 */
export type TemplateHealthFinding =
  | { kind: "numberDrawnAsPicture"; abstractNumId: number; ilvl: number }
  /** `rolesNotRead`: no style of the template could be read as the role
   *  of an article heading, a clause or body text (`roles`), because its
   *  sample text shows none in use: a filled document used as a template,
   *  or a template whose numbered styles carry no sample. Paragraphs of
   *  those roles are placed by fallbacks; the output wants a look. Sample
   *  paragraphs in the template's own styles mend it. */
  | { kind: "rolesNotRead"; roles: StructuralRole[] }
  /** `lastSectionNotBody`: the sample body stands in section
   *  `bodySection`, and the template ends with later sections (an exhibit,
   *  a signature page, a landscape annex). An output takes its page setup
   *  and its headers and footers from the template's last section. Ending
   *  the template with the body's section mends it. */
  | { kind: "lastSectionNotBody"; bodySection: number; lastSection: number }
  /** `headingStartsPage`: the style the template sets `role` in (an
   *  article heading, a clause, a party's line) starts every paragraph on
   *  a new page, so every such paragraph of a document starts one. The
   *  output does as the template says; a style without the page break
   *  mends it where that is not meant. */
  | { kind: "headingStartsPage"; role: PageRole; styleId: string }
  | { kind: "textDrawnAsPicture"; styleId: string | null }
  | {
      kind: "levelSetApart";
      role: LevelRole;
      styleId: string;
      bold: boolean;
      /** In half-points; null when the style and the defaults state none. */
      size: number | null;
      insteadStyleId: string;
    };

/** The roles of the numbered levels of a provision, outermost first. */
export const LEVEL_ROLES = [
  "clause1",
  "clause2",
  "clause3",
  "letter",
  "roman",
] as const satisfies readonly HouseStyleRole[];

type LevelRole = (typeof LEVEL_ROLES)[number];

/** Where the items of a list begin among the level roles. */
const ITEM_DEPTH = LEVEL_ROLES.indexOf("letter");

export type TemplateProfile = {
  version: 1;
  templateSha256: string;
  /** `parallelColumns` when the sample body runs in a table of two texts
   *  side by side; such a template is read, but not yet filled by column. */
  layout: "flow" | "parallelColumns";
  /** Total on purpose: a role the template has nothing for is `null`. */
  roles: Record<HouseStyleRole, ProfileRoleTarget | null>;
  /** Levels of the outline list no style uses, below the roles' own. A
   *  format the roles' levels do not print is patched onto one of them. */
  spareLevels: ProfileListLevel[];
  /** Levels of the template's other lists that no style uses. A bullet
   *  counts nothing, so its mark need not stand in the outline list: it is
   *  patched onto one of these first, and the outline's spare levels stay
   *  for formats that count. Absent from a profile inferred before them. */
  markLevels?: ProfileListLevel[];
  /** Top-level template blocks by what becomes of them. */
  regions: {
    /** Kept in front of the document: a letterhead, a memo header. */
    keepBefore: string[];
    /** The table of contents field with its caption, kept whole. Empty
     *  when the template has none, or when its field shows entries of the
     *  sample text: those cite headings that are dropped with the sample. */
    contents: string[];
    /** Sample text, dropped. */
    filler: string[];
  };
  /** Sample blocks a document's own parties and signatures stand in for. */
  slots: {
    party: { blockIds: string[] } | null;
    signature: { blockIds: string[] } | null;
  };
  /** The style the template sets the numbered line that heads a party in
   *  (a style named for parties, in a list of its own): a party's line
   *  that carries a number is placed in it and counted in that list.
   *  Absent when the template has none, and from a profile made before
   *  this was read. */
  partyHead?: ProfileRoleTarget;
  headings: { article: HeadingJoin; annex: HeadingJoin };
  /** Whether the template's sample starts a page between its front matter
   *  (title, parties) and its first article. Absent when the sample has no
   *  article, and from a profile made before this was read. */
  frontMatterEndsPage?: boolean;
  /** The paragraph styles the kept table of contents collects its entries
   *  from, by what its field names: styles by name, the built-in headings
   *  of a range of levels, styles with an outline level. A document none
   *  of whose headings is placed in one of them would get contents that
   *  fill empty. Absent when the template keeps no contents or its field's
   *  code is not known, and from a profile made before this was read. */
  contentsStyles?: string[];
  /** The deepest level the kept contents field takes by outline level
   *  (`\o "1-3"` gives 3): a paragraph given an outline level up to it is
   *  listed once the field also takes paragraphs' own levels. Absent when
   *  the field takes no levels, and from a profile made before this was
   *  read. */
  contentsDepth?: number;
  /** The template's styles for the lines of a table of contents, by the
   *  level their name gives (`toc 1` → 1): a source's contents that stay
   *  as lines of text are set in them. Absent when the template defines
   *  none, and from a profile made before this was read. */
  contentsLineStyles?: { level: number; styleId: string }[];
  /** The style the template writes the text of its tables in. Absent when
   *  it names none for that or its sample uses none, and from a profile
   *  made before this was read. */
  tableText?: { styleId: string };
  /** The cells of a kept letterhead that a letter's own head goes into:
   *  the sample lines of the addressee, the paragraph that shows the date,
   *  the one that names the file. Absent when the template keeps no such
   *  table, and from a profile made before this was read. */
  header?: TemplateHeader;
  /** The fields a kept header names beside an empty cell (a memo's `To:`,
   *  `From:`): the paragraph that names each and the one that takes its
   *  value. Absent when the template has no such header. */
  headerFields?: TemplateHeaderField[];
  fields: {
    /** Kinds replaced by their shown text: they prompt, or change on open. */
    freezeKinds: string[];
    /** Kinds that stay fields: page numbers, the file name, the contents. */
    liveKinds: string[];
  };
  /** Placeholder strings of the sample; none may reach an output. */
  fillerStrings: string[];
  /** How the template numbers an annex heading; null when it shows none. */
  annex: { numbering: "list" | "field" | "typed" } | null;
  /** The styles the template sets the provisions of an annex in, where it
   *  has a list of their own for them (a heading and its clauses, named
   *  for annexes): what stands under an annex heading is placed in these
   *  and counted in that list. Absent when the template has no such list,
   *  and from a profile made before this was read. */
  annexRoles?: AnnexRoles;
  /** The alignment of the template's default paragraph style, which a
   *  paragraph placed without a style takes; null when it states none.
   *  Absent from a profile inferred before it was read. */
  defaultAlignment?: string | null;
  /** What the template could have mended at its source. Absent from a
   *  profile inferred before the template was read for it. */
  health?: TemplateHealthFinding[];
  /** What becomes of a level the template sets apart from its siblings
   *  (`levelSetApart`): `even`, the default, places it in a sibling's
   *  style; `asTemplate` keeps the style the template gives it. */
  levelLooks?: "even" | "asTemplate";
  confidence: number;
};

const VOLATILE_FIELD_KINDS: ReadonlySet<string> = new Set([
  "FILLIN",
  "ASK",
  "DATE",
  "TIME",
]);
const CONTENTS_FIELD = "TOC";
/** The page reference each entry of a filled table of contents carries. */
const CONTENTS_ENTRY_FIELD = "PAGEREF";
const ANNEX_NUMBER_FIELDS: ReadonlySet<string> = new Set([
  "AUTONUM",
  "AUTONUMLGL",
  "SEQ",
]);

const NAME = {
  heading:
    /nadpis|článek|clanek|\bčl\b|article|heading|überschrift|artikel|\btitle\b/iu,
  paragraph: /odstavec|\bodst\b|paragraph|clause|absatz|abschnitt/iu,
  party: /smluvní stran|smluvni stran|\bpart(?:y|ies)\b|partei/iu,
  recital: /preambul|recital|präambel|whereas/iu,
  signature: /podpis|signature|unterschrift/iu,
  title: /centred|centered|\btitle\b|název|nazev|titul|\btitel\b/iu,
  continuation: /odsazen|indent|einzug|continu/iu,
  body: /základní|zakladni|body text|standard|fließtext|textkörper/iu,
  annexList: /seznam příloh|annex list|list of annexes|anlagenverzeichnis/iu,
  contents: /^(?:toc|obsah|verzeichnis|inhaltsverzeichnis)\b/iu,
  tableText: /tabul|\btable\b|tabelle/iu,
  preamble: /preamb|präambel/iu,
} as const;

const ANNEX_SAMPLE =
  /^(?:příloha|annexure|annex|schedule|appendix|exhibit|anlage|anhang)\b/iu;
const PARTY_SAMPLE =
  /sídl|IČO?\b|zapsan|zastoupen|registered|represented|company (?:no|number)|mit sitz|vertreten|handelsregister/iu;
const SIGNATURE_SAMPLE = /[.…_]{6,}/u;
const BRACKET_PLACEHOLDER = /\[[^\]\n]{1,80}\]/u;
const GENERIC_FILLER = [
  "Lorem ipsum",
  "Click or tap here",
  "Klikněte nebo klepněte sem",
  "Klicken oder tippen Sie hier",
] as const;
/** Literal text of a level beyond counters and their delimiters. */
const LEVEL_WORDS = /[^\s\d.()[\]\-–—/:,;%]/u;
/** A line that heads a table of contents and says nothing else. */
const CONTENTS_CAPTION =
  /^(?:obsah|contents|table of contents|inhalt|inhaltsverzeichnis)[ \u00A0]*:?$/iu;
/** Roles whose paragraphs are body text wherever they stand: the front
 *  matter of a template ends at the first of them. */
const BODY_START_ROLES = [
  "articleHeading",
  "clause1",
  "clause2",
  "clause3",
  "recital",
  "heading",
] as const satisfies readonly HouseStyleRole[];
/** A paragraph longer than this is prose of the sample, never a line of a
 *  letterhead or of a memo's header. */
const PROSE_LENGTH = 200;
/** What a doubt about the template takes off the profile's confidence. */
const UNCERTAIN_SHARE = 0.5;

const CONFIDENCE = {
  nameAndSample: 0.95,
  nameAndLevel: 0.9,
  name: 0.8,
  sample: 0.75,
  level: 0.7,
  fallback: 0.3,
} as const;

const NO_BLOCKS: readonly DocxBlock[] = [];
const NO_FINDINGS: readonly TemplateHealthFinding[] = [];
const NO_LEVELS: readonly ProfileListLevel[] = [];
const NO_HEADER_FIELDS: readonly TemplateHeaderField[] = [];

type StyleFacts = {
  style: TemplateStyle;
  level: ProfileListLevel | null;
  /** Sample paragraphs written in the style, in document order. */
  samples: readonly DocxBlock[];
};

/** Whether a list level prints a label: a number or a mark. A level in the
 *  format `none`, or with an empty level text, counts and shows nothing. */
const printsLabel = ({
  numFmt,
  lvlText,
}: Pick<ProfileListLevel, "numFmt" | "lvlText">): boolean =>
  numFmt !== "none" && lvlText.trim() !== "";

const target = (
  { style, level }: StyleFacts,
  confidence: number,
  ...evidence: RoleEvidence[]
): ProfileRoleTarget => ({
  styleId: style.styleId,
  alignment: style.alignment,
  // A level that prints nothing numbers nothing: the style keeps its role
  // and its place in the outline, without a list.
  numbering: level !== null && printsLabel(level) ? level : null,
  ...(style.indentLeft === undefined ? {} : { indentLeft: style.indentLeft }),
  ...(style.size === undefined ? {} : { size: style.size }),
  confidence,
  evidence,
});

const unnumbered = (role: ProfileRoleTarget): ProfileRoleTarget => ({
  ...role,
  numbering: null,
});

const nameOf = ({ style }: StyleFacts): string => style.name ?? style.styleId;

const isLetterFormat = (numFmt: string): boolean =>
  numFmt === "lowerLetter" || numFmt === "upperLetter";

const isRomanFormat = (numFmt: string): boolean =>
  numFmt === "lowerRoman" || numFmt === "upperRoman";

const collectStyleFacts = ({
  styles,
  numbering,
  blocks,
}: TemplateInspection): StyleFacts[] => {
  const abstractByNum = new Map(
    numbering.nums.map(({ numId, abstractNumId }) => [numId, abstractNumId]),
  );
  const levelsByAbstract = new Map(
    numbering.abstractNums.map(({ abstractNumId, levels }) => [
      abstractNumId,
      levels,
    ]),
  );
  const levelOf = ({ numPr }: TemplateStyle): ProfileListLevel | null => {
    if (numPr === null) {
      return null;
    }
    const abstractNumId = abstractByNum.get(numPr.numId);
    const level =
      abstractNumId === undefined
        ? undefined
        : levelsByAbstract
            .get(abstractNumId)
            ?.find(({ ilvl }) => ilvl === numPr.ilvl);
    if (abstractNumId === undefined || level === undefined) {
      return null;
    }
    return {
      numId: numPr.numId,
      ilvl: numPr.ilvl,
      abstractNumId,
      numFmt: level.numFmt,
      lvlText: level.lvlText,
      start: level.start,
      indent: level.indent,
    };
  };
  const samplesByStyle = Map.groupBy(
    blocks.filter(
      ({ kind, styleId }) => kind === "paragraph" && styleId !== null,
    ),
    ({ styleId }) => styleId ?? "",
  );
  return styles
    .filter(({ type }) => type === "paragraph")
    .map((style) => ({
      style,
      level: levelOf(style),
      // A style the sample text does not use has no samples.
      samples: samplesByStyle.get(style.styleId) ?? NO_BLOCKS,
    }));
};

/** Sample paragraphs counted when two outlines are ranked. */
const SAMPLES_RANKED_MAX = 999;

/** A style made for the annexes of a document, by its name. */
const ANNEX_STYLE = /příloh|priloh|annex|anlage|anhang|schedule|appendi/iu;

/**
 * The template's outline: of the lists with styles on two levels or more,
 * the one its sample text is written in. A template often carries further
 * lists with as many levels (schedules, a second language) that its sample
 * body never uses. Among lists used alike, the one with more levels, then
 * one whose styles are not named for annexes (the annexes of a report run
 * longer than its body), then the one with more sample paragraphs.
 */

const mainListOf = (facts: readonly StyleFacts[]): StyleFacts[] => {
  const byAbstract = Map.groupBy(
    facts.filter(({ level }) => level !== null),
    ({ level }) => level?.abstractNumId ?? -1,
  );
  /** What a list is ranked by, most telling first. */
  type Rank = { used: boolean; levels: number; body: boolean; samples: number };
  const outranks = (left: Rank, right: Rank): boolean => {
    if (left.used !== right.used) {
      return left.used;
    }
    if (left.levels !== right.levels) {
      return left.levels > right.levels;
    }
    return left.body === right.body ? left.samples > right.samples : left.body;
  };
  let best: StyleFacts[] = [];
  let bestRank: Rank | null = null;
  for (const group of byAbstract.values()) {
    const samples = group.reduce((sum, fact) => sum + fact.samples.length, 0);
    const rank: Rank = {
      used: samples > 0,
      levels: new Set(group.map(({ level }) => level?.ilvl)).size,
      body: !group.some((fact) => ANNEX_STYLE.test(nameOf(fact))),
      samples: Math.min(samples, SAMPLES_RANKED_MAX),
    };
    if (rank.levels >= 2 && (bestRank === null || outranks(rank, bestRank))) {
      best = group;
      bestRank = rank;
    }
  }
  // By level; within a level the style the sample text uses comes first.
  return best.toSorted(
    (left, right) =>
      (left.level?.ilvl ?? 0) - (right.level?.ilvl ?? 0) ||
      right.samples.length - left.samples.length,
  );
};

const OUTLINE_ROLES = [
  "articleHeading",
  "clause1",
  "clause2",
  "clause3",
  "letter",
  "roman",
] as const satisfies readonly HouseStyleRole[];

type OutlineRoles = Partial<
  Record<(typeof OUTLINE_ROLES)[number], ProfileRoleTarget>
>;

/** The roles of an outline, as an annex's own list fills them. */
export type AnnexRoles = OutlineRoles;

/**
 * The clause depths among counted levels: levels in a row, the first one
 * directly under the heading. `1.1.` stands directly under `1.`, `1.1.1.`
 * directly under that; a counted level further down the list, past a
 * lettered or roman one, is not the next clause depth. `printing` are the
 * levels of the outline that print a label, in order: a level that prints
 * nothing does not part two depths.
 */
const clauseChain = (
  counted: readonly StyleFacts[],
  printing: readonly number[],
  heading: StyleFacts | null,
): StyleFacts[] => {
  const positionOf = (fact: StyleFacts | undefined): number | undefined =>
    fact?.level === null || fact === undefined
      ? undefined
      : printing.indexOf(fact.level.ilvl);
  const chain: StyleFacts[] = [];
  let above = heading === null ? undefined : positionOf(heading);
  for (const fact of counted) {
    const position = positionOf(fact);
    if (above !== undefined && position !== above + 1) {
      break;
    }
    chain.push(fact);
    above = position;
  }
  return chain;
};

/** Sorts the outline's levels: the lettered and roman ones to their roles,
 *  a top level without a label to the heading, the counted ones in order. */
const sortOutline = (
  outline: readonly StyleFacts[],
): { roles: OutlineRoles; counted: StyleFacts[]; printing: number[] } => {
  const roles: OutlineRoles = {};
  const counted: StyleFacts[] = [];
  const printing = new Set<number>();
  for (const fact of outline) {
    const numFmt = fact.level?.numFmt ?? "";
    const top = fact.level?.ilvl === 0;
    if (fact.level !== null && !printsLabel(fact.level)) {
      // The top level of the outline is its heading also when it prints
      // no number; a level below that prints nothing is no depth of it.
      if (top) {
        roles.articleHeading ??= target(fact, CONFIDENCE.level, "listLevel");
      }
      continue;
    }
    if (fact.level !== null) {
      printing.add(fact.level.ilvl);
    }
    if (isLetterFormat(numFmt) && !top) {
      roles.letter ??= target(fact, CONFIDENCE.nameAndLevel, "listLevel");
    } else if (isRomanFormat(numFmt) && !top) {
      roles.roman ??= target(fact, CONFIDENCE.nameAndLevel, "listLevel");
    } else if (
      (numFmt === "decimal" || top) &&
      // Two styles on one level are one level of the outline: the first,
      // which is the one the sample text uses, stands for it.
      !counted.some(({ level }) => level?.ilvl === fact.level?.ilvl)
    ) {
      counted.push(fact);
    }
  }
  return {
    roles,
    counted,
    printing: [...printing].toSorted((left, right) => left - right),
  };
};

/** Reads the outline: counted levels are the heading and the clauses under
 *  it, the lettered level the letter items, the roman level below the
 *  points. */
const readOutline = (outline: readonly StyleFacts[]): OutlineRoles => {
  const { roles, counted, printing } = sortOutline(outline);
  const first = counted.at(0);
  if (first === undefined) {
    return roles;
  }
  const name = nameOf(first);
  const words = LEVEL_WORDS.test(first.level?.lvlText ?? "");
  // A level named a paragraph and printing a bare number is a clause; the
  // template then heads its sections outside this list, or not at all.
  const headsArticles =
    roles.articleHeading === undefined &&
    (words || NAME.heading.test(name) || !NAME.paragraph.test(name));
  const clauses = headsArticles ? counted.slice(1) : counted;
  if (headsArticles) {
    roles.articleHeading = target(
      first,
      words || NAME.heading.test(name)
        ? CONFIDENCE.nameAndLevel
        : CONFIDENCE.level,
      ...(NAME.heading.test(name) ? (["styleName"] as const) : []),
      "listLevel",
    );
  }
  const [first1, first2, first3] = clauseChain(
    clauses,
    printing,
    headsArticles ? first : null,
  ).map((fact) => target(fact, CONFIDENCE.nameAndLevel, "listLevel"));
  if (first1 !== undefined) {
    roles.clause1 = first1;
  }
  if (first2 !== undefined) {
    roles.clause2 = first2;
  }
  if (first3 !== undefined) {
    roles.clause3 = first3;
  }
  return roles;
};

/**
 * The style of the numbered line that heads a party: named for parties,
 * on a level of a list that is not the main outline's and prints a number.
 * Among several, the one the sample text uses. Undefined when the template
 * has none.
 */
const inferPartyHead = (
  facts: readonly StyleFacts[],
  roles: TemplateProfile["roles"],
): ProfileRoleTarget | undefined => {
  const main = roles.articleHeading?.numbering?.abstractNumId;
  const head = byName(
    facts,
    NAME.party,
    ({ level }) =>
      level !== null && level.abstractNumId !== main && printsLabel(level),
  );
  return head === undefined
    ? undefined
    : target(head, CONFIDENCE.nameAndLevel, "styleName", "listLevel");
};

/**
 * The outline the template keeps for its annexes: another list than the
 * main one, with styles on two levels or more that are all named for
 * annexes, and a level that heads articles. Among several, the one with
 * more levels. Undefined when the template has none.
 */
const inferAnnexRoles = (
  facts: readonly StyleFacts[],
  roles: TemplateProfile["roles"],
): AnnexRoles | undefined => {
  // The main outline's list, also where its heading prints no number.
  const main = OUTLINE_ROLES.map(
    (role) => roles[role]?.numbering?.abstractNumId,
  ).find((abstractNumId) => abstractNumId !== undefined);
  const lists = Map.groupBy(
    facts.filter(({ level }) => level !== null),
    ({ level }) => level?.abstractNumId ?? -1,
  );
  let best: AnnexRoles | undefined;
  let bestLevels = 0;
  for (const [abstractNumId, group] of lists) {
    const levels = new Set(group.map(({ level }) => level?.ilvl)).size;
    if (
      main === undefined ||
      abstractNumId === main ||
      levels < 2 ||
      levels <= bestLevels ||
      !group.every((fact) => ANNEX_STYLE.test(nameOf(fact)))
    ) {
      continue;
    }
    const read = readOutline(
      group.toSorted(
        (left, right) => (left.level?.ilvl ?? 0) - (right.level?.ilvl ?? 0),
      ),
    );
    if (read.articleHeading !== undefined) {
      best = inOneList(read, read.articleHeading);
      bestLevels = levels;
    }
  }
  return best;
};

/**
 * The roles of an outline with every level in the list its heading is in.
 * Styles of one outline may name different lists of the same definition;
 * paragraphs that count together are numbered in one.
 */
const inOneList = (
  roles: OutlineRoles,
  { numbering: heading }: ProfileRoleTarget,
): OutlineRoles =>
  Object.fromEntries(
    Object.entries(roles).map(([role, placed]) => [
      role,
      heading === null || placed.numbering === null
        ? placed
        : {
            ...placed,
            numbering: { ...placed.numbering, numId: heading.numId },
          },
    ]),
  );

const byName = (
  facts: readonly StyleFacts[],
  pattern: RegExp,
  accept: (fact: StyleFacts) => boolean = () => true,
): StyleFacts | undefined => {
  const named = facts.filter(
    (fact) => pattern.test(nameOf(fact)) && accept(fact),
  );
  // A style the sample text uses is the one the template means.
  return named.find(({ samples }) => samples.length > 0) ?? named.at(0);
};

const bySample = (
  facts: readonly StyleFacts[],
  pattern: RegExp,
  accept: (fact: StyleFacts) => boolean = () => true,
): StyleFacts | undefined => {
  let best: StyleFacts | undefined;
  let bestCount = 0;
  for (const fact of facts) {
    const count = accept(fact)
      ? fact.samples.filter(({ text }) => pattern.test(text)).length
      : 0;
    if (count > bestCount) {
      best = fact;
      bestCount = count;
    }
  }
  return best;
};

const isUnnumbered = ({ level }: StyleFacts): boolean => level === null;

const inferRoles = (
  facts: readonly StyleFacts[],
  topLevel: readonly DocxBlock[],
): TemplateProfile["roles"] => {
  const outline = mainListOf(facts);
  const inOutline = new Set(outline.map(({ style }) => style.styleId));
  const outside = facts.filter(({ style }) => !inOutline.has(style.styleId));
  const fromOutline = readOutline(outline);

  const namedHeading = byName(
    outside,
    NAME.heading,
    ({ level, style }) => level !== null || style.outlineLvl !== null,
  );
  const articleHeading =
    fromOutline.articleHeading ??
    (namedHeading === undefined
      ? null
      : target(namedHeading, CONFIDENCE.name, "styleName"));

  const namedRecital = byName(outside, NAME.recital, ({ level }) =>
    isLetterFormat(level?.numFmt ?? ""),
  );
  const recital =
    namedRecital === undefined
      ? null
      : target(namedRecital, CONFIDENCE.nameAndLevel, "styleName", "listLevel");

  const partySample = bySample(outside, PARTY_SAMPLE, isUnnumbered);
  const partyNamed = byName(outside, NAME.party);
  let party: ProfileRoleTarget | null = null;
  if (partySample !== undefined) {
    party = target(partySample, CONFIDENCE.sample, "sample");
  } else if (partyNamed !== undefined) {
    // The numbered style heads a party; its details carry no number.
    party = unnumbered(target(partyNamed, CONFIDENCE.name, "styleName"));
  }

  const signatureNamed = byName(outside, NAME.signature, isUnnumbered);
  const signatureSample = bySample(outside, SIGNATURE_SAMPLE, isUnnumbered);
  let signature: ProfileRoleTarget | null = null;
  if (signatureNamed !== undefined) {
    signature =
      signatureNamed === signatureSample
        ? target(
            signatureNamed,
            CONFIDENCE.nameAndSample,
            "styleName",
            "sample",
          )
        : target(signatureNamed, CONFIDENCE.name, "styleName");
  }

  const firstText = topLevel.find(
    ({ kind, text }) => kind === "paragraph" && text.trim() !== "",
  );
  const titleNamed = byName(outside, NAME.title, isUnnumbered);
  const titleFirst = outside.find(
    ({ style, level }) =>
      level === null && style.styleId === firstText?.styleId,
  );
  let title: ProfileRoleTarget | null = null;
  if (titleNamed !== undefined) {
    title =
      titleNamed === titleFirst
        ? target(titleNamed, CONFIDENCE.nameAndSample, "styleName", "sample")
        : target(titleNamed, CONFIDENCE.name, "styleName");
  }

  const continuationNamed = byName(outside, NAME.continuation, isUnnumbered);
  const bodyNamed = byName(outside, NAME.body, isUnnumbered);
  const defaultStyle = facts.find(({ style }) => style.isDefault);
  let body: ProfileRoleTarget | null = null;
  if (bodyNamed !== undefined) {
    body = target(bodyNamed, CONFIDENCE.name, "styleName");
  } else if (defaultStyle !== undefined) {
    body = unnumbered(target(defaultStyle, CONFIDENCE.fallback, "fallback"));
  }

  // A heading style may carry a bullet list too; a bullet is body text.
  const bulleted =
    facts.find(
      ({ level, style, samples }) =>
        level?.numFmt === "bullet" &&
        style.outlineLvl === null &&
        samples.length > 0,
    ) ??
    facts.find(
      ({ level, style }) =>
        level?.numFmt === "bullet" && style.outlineLvl === null,
    );
  // An entry of a filled table of contents names annexes too ("Annex 1 …
  // 12"); a contents style is never the annex heading's.
  const annexSample = bySample(
    outside,
    ANNEX_SAMPLE,
    (fact) => !NAME.contents.test(nameOf(fact)),
  );
  const annexListNamed = byName(outside, NAME.annexList);
  // The style of a heading without a number (`Preambule`): named for the
  // preamble and in no list; the numbered one of that name is the recital's.
  const headingNamed = byName(
    outside,
    NAME.preamble,
    (fact) => isUnnumbered(fact) && fact.style.type === "paragraph",
  );

  return {
    title,
    party,
    recital,
    articleHeading,
    clause1: fromOutline.clause1 ?? null,
    clause2: fromOutline.clause2 ?? null,
    clause3: fromOutline.clause3 ?? null,
    letter: fromOutline.letter ?? null,
    roman: fromOutline.roman ?? null,
    bullet:
      bulleted === undefined
        ? null
        : target(bulleted, CONFIDENCE.level, "listLevel"),
    continuation:
      continuationNamed === undefined
        ? null
        : target(continuationNamed, CONFIDENCE.name, "styleName"),
    signature,
    annexList:
      annexListNamed === undefined
        ? null
        : target(annexListNamed, CONFIDENCE.name, "styleName"),
    annexHeading:
      annexSample === undefined
        ? null
        : unnumbered(target(annexSample, CONFIDENCE.sample, "sample")),
    heading:
      headingNamed === undefined
        ? null
        : target(headingNamed, CONFIDENCE.name, "styleName"),
    body,
  };
};

const joinOf = (samples: readonly DocxBlock[]): HeadingJoin =>
  samples.some(({ text }) => text.trim().includes("\n"))
    ? "lineBreak"
    : "sameLine";

/**
 * The style of the text in the template's tables: a paragraph style named
 * for tables, in no list, that the sample writes in table cells only. Of
 * several, the one the sample uses most.
 */
const inferTableText = (
  facts: readonly StyleFacts[],
  nested: ReadonlySet<string>,
): TemplateProfile["tableText"] => {
  const [most] = facts
    .filter(
      ({ style, level, samples }) =>
        style.type === "paragraph" &&
        level === null &&
        NAME.tableText.test(style.name ?? style.styleId) &&
        samples.length > 0 &&
        samples.every(({ id }) => nested.has(id)),
    )
    .toSorted((left, right) => right.samples.length - left.samples.length);
  return most === undefined ? undefined : { styleId: most.style.styleId };
};

type Structure = {
  topLevel: DocxBlock[];
  nestedOf: Map<string, DocxBlock[]>;
};

const readStructure = (blocks: readonly DocxBlock[]): Structure => {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const nestedOf = new Map<string, DocxBlock[]>();
  const nestedIds = new Set<string>();
  for (const block of blocks) {
    if (block.cells === undefined) {
      continue;
    }
    const inside = block.cells.flatMap(({ blockIds }) =>
      blockIds.flatMap((id) => {
        const inner = byId.get(id);
        return inner === undefined ? [] : [inner];
      }),
    );
    nestedOf.set(block.id, inside);
    for (const { id } of inside) {
      nestedIds.add(id);
    }
  }
  return {
    topLevel: blocks.filter(({ id }) => !nestedIds.has(id)),
    nestedOf,
  };
};

type TemplateHeader = {
  /** The sample lines of the addressee, in order: block ids. */
  addressee: string[];
  date: string | null;
  reference: string | null;
};

type TemplateHeaderField = {
  field: HeadField;
  /** The word the template names the field with: `Subject`. */
  name: string;
  /** The paragraph that names the field. */
  labelBlockId: string;
  /** The empty paragraph beside it. */
  valueBlockId: string;
};

/**
 * Reads the fields a kept header table names beside an empty cell: a cell
 * whose one line of text is the name of a field (`To:`), and the cell after
 * it in its row, which holds one paragraph without text. A field the table
 * names twice is read at neither place.
 */
const inferHeaderFields = (
  { topLevel, nestedOf }: Structure,
  keepBefore: readonly string[],
): TemplateHeaderField[] => {
  const found: TemplateHeaderField[] = [];
  for (const table of topLevel) {
    const nested = nestedOf.get(table.id);
    const { cells } = table;
    if (
      table.kind !== "table" ||
      !keepBefore.includes(table.id) ||
      nested === undefined ||
      cells === undefined
    ) {
      continue;
    }
    const byId = new Map(nested.map((block) => [block.id, block]));
    for (const cell of cells) {
      const beside = cells.find(
        ({ row, col }) => row === cell.row && col === cell.col + 1,
      );
      const [label, ...more] = cell.blockIds.flatMap((id) => {
        const block = byId.get(id);
        return block === undefined || block.text.trim() === "" ? [] : [block];
      });
      const value =
        beside?.blockIds.length === 1
          ? byId.get(beside.blockIds.at(0) ?? "")
          : undefined;
      const named = label === undefined ? null : readFieldName(label.text);
      if (
        label !== undefined &&
        more.length === 0 &&
        named !== null &&
        value?.kind === "paragraph" &&
        value.text.trim() === "" &&
        (value.inlineObjects ?? 0) === 0
      ) {
        found.push({
          field: named.field,
          name: named.word,
          labelBlockId: label.id,
          valueBlockId: value.id,
        });
      }
    }
  }
  return found.filter(
    ({ field }) => found.filter((other) => other.field === field).length === 1,
  );
};

const HEADER_REFERENCE =
  /^(?:file (?:no|number)|reference|our ref|č\.[ \u00A0]?j\.|sp\.[ \u00A0]?zn\.|spisová značka|naše značka|aktenzeichen|unser zeichen)/iu;
const HEADER_DATE =
  /^\d{1,2}\.?[ \u00A0]+\p{L}{3,}[ \u00A0]+\d{4}$|^\d{1,2}\.[ \u00A0]?\d{1,2}\.[ \u00A0]?\d{4}$|^\p{L}{3,}[ \u00A0]+\d{1,2},[ \u00A0]+\d{4}$/u;
const HEADER_ADDRESSEE_MAX = 6;

/**
 * Reads the letterhead a template keeps: the first kept table. The lines
 * its first cell opens with, up to the first line that is a label
 * (`Via post / E-mail:`), are the sample of an addressee; a paragraph that
 * is a date and one that names the file are the cells for those.
 */
const inferHeader = (
  { topLevel, nestedOf }: Structure,
  keepBefore: readonly string[],
): TemplateHeader | undefined => {
  const table = topLevel.find(
    ({ id, kind }) => kind === "table" && keepBefore.includes(id),
  );
  const nested = table === undefined ? undefined : nestedOf.get(table.id);
  if (table === undefined || nested === undefined) {
    return undefined;
  }
  const shown = nested.filter(
    ({ kind, text }) => kind === "paragraph" && text.trim() !== "",
  );
  const firstCell = new Set(table.cells?.at(0)?.blockIds);
  const opening = shown.filter(({ id }) => firstCell.has(id));
  const label = opening.findIndex(({ text }) => text.trim().endsWith(":"));
  const date = shown.find(({ text }) => HEADER_DATE.test(text.trim()));
  const reference = shown.find(({ text }) =>
    HEADER_REFERENCE.test(text.trim()),
  );
  // A date or a reference under the address is no line of it: a paragraph
  // takes one thing.
  const sample = (label === -1 ? opening : opening.slice(0, label)).filter(
    (block) => block !== date && block !== reference,
  );
  const addressee =
    sample.length >= 2 && sample.length <= HEADER_ADDRESSEE_MAX
      ? sample.map(({ id }) => id)
      : [];
  // A header of label and value cells (a memo's `From:`, `To:`) has no
  // sample of an addressee and no date of its own: its labels stay.
  return addressee.length === 0 && date === undefined
    ? undefined
    : {
        addressee,
        date: date?.id ?? null,
        reference: reference?.id ?? null,
      };
};

type RegionOptions = {
  inspection: TemplateInspection;
  structure: Structure;
  roles: TemplateProfile["roles"];
};

/** The switch of a contents field that names styles and their levels:
 *  `\t "Name;1;Other;2"`. */
const CONTENTS_NAMED = /\\t\s+"(?<named>[^"]*)"/u;
/** The switch that takes the built-in headings, of a range of levels or of
 *  all nine. */
const CONTENTS_HEADINGS = /\\o(?:\s+"(?<low>\d)-(?<high>\d)")?/u;
/** The switch that takes every paragraph with an outline level. */
const CONTENTS_OUTLINED = /\\u(?![a-z])/iu;
const BUILT_IN_HEADING = /^heading (?<level>[1-9])$/iu;

/**
 * The paragraph styles a contents field collects its entries from, read off
 * its code. Names and levels alternate in the `\t` switch, parted by the
 * list separator of the machine that wrote it: a semicolon or a comma.
 * Undefined when the code is not known.
 */
const collectedStyles = (
  instruction: string | undefined,
  styles: readonly TemplateStyle[],
): string[] | undefined => {
  if (instruction === undefined) {
    return undefined;
  }
  const named = CONTENTS_NAMED.exec(instruction)?.groups?.["named"] ?? "";
  const names = new Set(
    named
      .split(named.includes(";") ? ";" : ",")
      .filter((_part, position) => position % 2 === 0)
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
  const headings = CONTENTS_HEADINGS.exec(instruction);
  // Levels are single digits and compare as text.
  const low = headings?.groups?.["low"] ?? "1";
  const high = headings?.groups?.["high"] ?? "9";
  const outlined = CONTENTS_OUTLINED.test(instruction);
  return styles
    .filter(({ type, name, outlineLvl }) => {
      if (type !== "paragraph") {
        return false;
      }
      // A built-in heading by its name, any other style by the outline
      // level it states (counted from zero).
      const level =
        BUILT_IN_HEADING.exec(name ?? "")?.groups?.["level"] ??
        (outlineLvl === null ? undefined : String(outlineLvl + 1));
      return (
        names.has((name ?? "").toLowerCase()) ||
        (headings !== null &&
          level !== undefined &&
          level >= low &&
          level <= high) ||
        (outlined && outlineLvl !== null)
      );
    })
    .map(({ styleId }) => styleId);
};

/** Roles whose style the paragraph after a table of contents is in when
 *  it heads the sample body. */
const HEADING_ROLES = [
  ...BODY_START_ROLES,
  "title",
  "annexHeading",
] as const satisfies readonly HouseStyleRole[];

/**
 * Whether the block a table of contents ends in is the next heading's
 * paragraph (the field's end was left in front of it): a paragraph with
 * text in a heading style of the template, not a style of the contents.
 * It is sample text, not part of the contents, and the contents are kept
 * without it.
 */
const endsInNextHeading = (
  end: DocxBlock | undefined,
  roles: TemplateProfile["roles"],
): boolean =>
  end?.kind === "paragraph" &&
  end.text.trim() !== "" &&
  !NAME.contents.test(end.styleName ?? end.styleId ?? "") &&
  HEADING_ROLES.some((role) => roles[role]?.styleId === end.styleId);

const inferRegions = ({
  inspection: { fields, styles },
  structure: { topLevel, nestedOf },
  roles,
}: RegionOptions): Pick<
  TemplateProfile,
  | "regions"
  | "slots"
  | "contentsStyles"
  | "contentsDepth"
  | "contentsLineStyles"
> => {
  const order = topLevel.map(({ id }) => id);
  const contents: string[] = [];
  let contentsStyles: string[] | undefined;
  let contentsDepth: number | undefined;
  const contentsField = fields.find(
    ({ kind, blockId }) => kind === CONTENTS_FIELD && blockId !== undefined,
  );
  if (contentsField?.blockId !== undefined) {
    const from = order.indexOf(contentsField.blockId);
    const to = order.indexOf(contentsField.endBlockId ?? contentsField.blockId);
    // A field that shows sample entries is kept too: the engine writes it
    // without them. Not one inside a table (contents set in two columns):
    // there the entries would stay, so such a field is kept only empty.
    const span = new Set(order.slice(from, to + 1));
    const entriesInTable =
      topLevel[from]?.kind === "table" &&
      fields.some(
        ({ kind, blockId }) =>
          kind === CONTENTS_ENTRY_FIELD &&
          blockId !== undefined &&
          span.has(blockId),
      );
    if (from !== -1 && to >= from && !entriesInTable) {
      const caption = topLevel[from - 1];
      // The caption above the field belongs to it. A short line that does
      // not name the contents is sample text of something else.
      if (
        caption?.kind === "paragraph" &&
        CONTENTS_CAPTION.test(caption.text.trim())
      ) {
        contents.push(caption.id);
      }
      const endsInHeading = to > from && endsInNextHeading(topLevel[to], roles);
      contents.push(...order.slice(from, endsInHeading ? to : to + 1));
      contentsStyles = collectedStyles(contentsField.instruction, styles);
      const headings = CONTENTS_HEADINGS.exec(contentsField.instruction ?? "");
      if (headings !== null) {
        contentsDepth = Number(headings.groups?.["high"] ?? "9");
      }
    }
  }
  const inContents = new Set(contents);

  const numberedStyles = new Set(
    Object.values(roles).flatMap((role) =>
      role?.numbering ? [role.styleId] : [],
    ),
  );
  const partyStyle = roles.party?.styleId;
  const signatureStyle = roles.signature?.styleId;
  const insideOf = (block: DocxBlock): readonly DocxBlock[] => {
    if (block.kind !== "table") {
      return [block];
    }
    // A table without cells holds nothing.
    return nestedOf.get(block.id) ?? NO_BLOCKS;
  };
  // The sample body starts at the first numbered sample paragraph, alone
  // or in a table, or at the table of contents; what stands before it is
  // front matter. A template that is really a filled document may number
  // nothing by its styles: there the body starts no later than its first
  // heading, its first numbered paragraph outside a table, or its first
  // paragraph of prose. No letterhead holds one, and without that bound
  // everything up to the document's last table (its signatures) would be
  // kept as a letterhead.
  const bodyStyles = new Set(
    BODY_START_ROLES.flatMap((role) => {
      const styleId = roles[role]?.styleId;
      return styleId === undefined ? [] : [styleId];
    }),
  );
  const bodyStart = topLevel.findIndex(
    (block) =>
      inContents.has(block.id) ||
      insideOf(block).some(
        ({ label, styleId }) =>
          label !== null && numberedStyles.has(styleId ?? ""),
      ) ||
      (block.kind === "paragraph" &&
        (bodyStyles.has(block.styleId ?? "") ||
          block.label !== null ||
          block.text.trim().length > PROSE_LENGTH)),
  );
  const front = bodyStart === -1 ? topLevel : topLevel.slice(0, bodyStart);
  const isSample = (block: DocxBlock): boolean =>
    insideOf(block).some(
      ({ text, styleId }) =>
        text.search(BRACKET_PLACEHOLDER) !== -1 ||
        (styleId === partyStyle && PARTY_SAMPLE.test(text)),
    );
  // A table in the front matter that is not sample text is a letterhead or
  // a header of label and value cells; it is kept with what stands above
  // it and the objects right below. Front matter without one is a sample
  // title.
  const isFurniture = (block: DocxBlock): boolean =>
    (block.kind === "table" || (block.inlineObjects ?? 0) > 0) &&
    !isSample(block);
  const lastKept = front.findLastIndex(isFurniture);
  const keepBefore = front.some(
    (block) => block.kind === "table" && isFurniture(block),
  )
    ? front
        .slice(0, lastKept + 1)
        .filter(
          (block) =>
            !isSample(block) &&
            (block.kind === "table" ||
              block.text.trim() !== "" ||
              (block.inlineObjects ?? 0) > 0),
        )
        .map(({ id }) => id)
    : [];
  const kept = new Set([...keepBefore, ...contents]);

  /** Every block from the first to the last that matches: one sample. */
  const spanOf = (matches: (block: DocxBlock) => boolean): string[] => {
    const first = topLevel.findIndex(matches);
    const last = topLevel.findLastIndex(matches);
    return first === -1
      ? []
      : topLevel
          .slice(first, last + 1)
          .filter(({ id }) => !kept.has(id))
          .map(({ id }) => id);
  };
  const partyBlocks = spanOf(
    (block) =>
      !kept.has(block.id) &&
      partyStyle !== undefined &&
      insideOf(block).some(
        ({ styleId, text }) =>
          styleId === partyStyle && PARTY_SAMPLE.test(text),
      ),
  );
  const signatureBlocks = spanOf(
    (block) =>
      !kept.has(block.id) &&
      block.kind === "table" &&
      insideOf(block).some(
        ({ styleId, text }) =>
          styleId === signatureStyle || SIGNATURE_SAMPLE.test(text),
      ),
  );

  return {
    regions: {
      keepBefore,
      contents,
      filler: order.filter((id) => !kept.has(id)),
    },
    slots: {
      party: partyBlocks.length === 0 ? null : { blockIds: partyBlocks },
      signature:
        signatureBlocks.length === 0 ? null : { blockIds: signatureBlocks },
    },
    ...(contentsStyles === undefined ? {} : { contentsStyles }),
    ...(contentsDepth === undefined ? {} : { contentsDepth }),
    ...contentsLineStylesOf(styles),
  };
};

/** A style named for a level of a table of contents: `toc 1`, `TOC 2`. */
const CONTENTS_LINE_STYLE = /^toc (?<level>[1-9])$/iu;

const contentsLineStylesOf = (
  styles: readonly TemplateStyle[],
): Pick<TemplateProfile, "contentsLineStyles"> => {
  const found = styles.flatMap(({ styleId, name, type }) => {
    const level = CONTENTS_LINE_STYLE.exec(name?.trim() ?? "")?.groups?.[
      "level"
    ];
    return type === "paragraph" && level !== undefined
      ? [{ level: Number(level), styleId }]
      : [];
  });
  // One style a level: the first that names it.
  const byLevel = new Map<number, string>();
  for (const { level, styleId } of found) {
    if (!byLevel.has(level)) {
      byLevel.set(level, styleId);
    }
  }
  return byLevel.size === 0
    ? {}
    : {
        contentsLineStyles: [...byLevel]
          .map(([level, styleId]) => ({ level, styleId }))
          .toSorted((a, b) => a.level - b.level),
      };
};

const inferFillerStrings = (blocks: readonly DocxBlock[]): string[] => {
  const found = new Set<string>();
  for (const { kind, text } of blocks) {
    if (kind !== "paragraph") {
      continue;
    }
    for (const [placeholder] of text.matchAll(
      new RegExp(BRACKET_PLACEHOLDER, "gu"),
    )) {
      found.add(placeholder);
    }
    for (const phrase of GENERIC_FILLER) {
      if (text.includes(phrase)) {
        found.add(phrase);
      }
    }
  }
  return [...found];
};

const STRUCTURAL_ROLES = [
  "articleHeading",
  "clause1",
  "body",
] as const satisfies readonly HouseStyleRole[];

type StructuralRole = (typeof STRUCTURAL_ROLES)[number];

/** Roles whose style starting a page would start one for every
 *  paragraph of the role. */
const PAGE_ROLES = [
  "articleHeading",
  "clause1",
  "party",
] as const satisfies readonly HouseStyleRole[];

type PageRole = (typeof PAGE_ROLES)[number];

/** A list has nine levels; a template has some lists and some styles. A
 *  template with more findings than this is reported up to here: the
 *  profile stays readable, and so many say the same thing anyway. */
const HEALTH_FINDINGS_MAX = 2000;

type Look = { bold: boolean; size: number | null };

const sameLook = (left: Look, right: Look): boolean =>
  left.bold === right.bold && left.size === right.size;

/**
 * The numbered levels whose style looks other than the levels around it:
 * bold, or in another size. The look the levels are held to is the one most
 * of their styles and the body's share; without such a look, or without
 * the styles' looks in the inspection, nothing is found.
 */
const levelsSetApart = (
  { styles }: TemplateInspection,
  roles: TemplateProfile["roles"],
): TemplateHealthFinding[] => {
  const lookOf = (styleId: string | undefined): Look | null => {
    const style = styles.find((candidate) => candidate.styleId === styleId);
    const bold = style?.bold;
    return bold === undefined ? null : { bold, size: style?.size ?? null };
  };
  const levels = LEVEL_ROLES.flatMap((role, depth) => {
    const styleId = roles[role]?.styleId;
    const look = lookOf(styleId);
    return styleId === undefined || look === null
      ? []
      : [{ role, depth, styleId, look }];
  });
  const body = lookOf(roles.body?.styleId);
  const looksByStyle = new Map(
    levels.map(({ styleId, look }) => [styleId, look]),
  );
  if (roles.body !== null && body !== null) {
    looksByStyle.set(roles.body.styleId, body);
  }
  // Each look once, with the number of styles that have it.
  const byLook = new Map<string, { look: Look; styles: number }>();
  for (const look of looksByStyle.values()) {
    const key = `${String(look.bold)}:${String(look.size)}`;
    const counted = byLook.get(key);
    if (counted === undefined) {
      byLook.set(key, { look, styles: 1 });
    } else {
      counted.styles += 1;
    }
  }
  const [most, next] = [...byLook.values()].toSorted(
    (left, right) => right.styles - left.styles,
  );
  // Two looks with as many styles each: none is the template's own.
  if (
    most === undefined ||
    most.styles < 2 ||
    (next !== undefined && next.styles === most.styles)
  ) {
    return [];
  }
  const even = levels.filter(({ look }) => sameLook(look, most.look));
  return levels.flatMap(({ role, depth, styleId, look }) => {
    if (sameLook(look, most.look)) {
      return [];
    }
    // A level of its own kind first (a clause for a clause, an item for
    // an item), then the nearest, the outer one of two.
    const otherKind = (other: number): number =>
      other < ITEM_DEPTH === depth < ITEM_DEPTH ? 0 : 1;
    const instead = even.toSorted(
      (left, right) =>
        otherKind(left.depth) - otherKind(right.depth) ||
        Math.abs(left.depth - depth) - Math.abs(right.depth - depth) ||
        left.depth - right.depth,
    )[0];
    return instead === undefined
      ? []
      : [
          {
            kind: "levelSetApart" as const,
            role,
            styleId,
            bold: look.bold,
            size: look.size,
            insteadStyleId: instead.styleId,
          },
        ];
  });
};

/** The template's findings, each once, in the order the template has them. */
const inferHealth = (
  inspection: TemplateInspection,
  roles: TemplateProfile["roles"],
): TemplateHealthFinding[] => {
  const { invisibleEffects = [] } = inspection;
  const findings = new Map<string, TemplateHealthFinding>();
  for (const { effect, owner } of invisibleEffects) {
    // Of the effects that show nothing only the 3-D scene changes how the
    // text is written out.
    if (effect !== "scene3d") {
      continue;
    }
    if (owner.kind === "level") {
      if (owner.abstractNumId !== null && owner.ilvl !== null) {
        const { abstractNumId, ilvl } = owner;
        findings.set(`level ${String(abstractNumId)} ${String(ilvl)}`, {
          kind: "numberDrawnAsPicture",
          abstractNumId,
          ilvl,
        });
      }
    } else if (owner.kind === "style" || owner.kind === "defaults") {
      const styleId = owner.kind === "style" ? owner.styleId : null;
      findings.set(`style ${styleId ?? ""}`, {
        kind: "textDrawnAsPicture",
        styleId,
      });
    }
  }
  for (const finding of levelsSetApart(inspection, roles)) {
    if (finding.kind === "levelSetApart") {
      findings.set(`apart ${finding.role}`, finding);
    }
  }
  for (const role of PAGE_ROLES) {
    const styleId = roles[role]?.styleId;
    const style = inspection.styles.find(
      (candidate) => candidate.styleId === styleId,
    );
    if (styleId !== undefined && style?.pageBreakBefore === true) {
      findings.set(`page ${role}`, {
        kind: "headingStartsPage",
        role,
        styleId,
      });
    }
  }
  const unread = STRUCTURAL_ROLES.filter((role) => roles[role] === null);
  // The body's section: that of the first paragraph in a heading or
  // clause style of the template.
  const bodyStyles = new Set(
    BODY_START_ROLES.flatMap((role) => {
      const styleId = roles[role]?.styleId;
      return styleId === undefined ? [] : [styleId];
    }),
  );
  const bodySection = inspection.blocks.find(({ styleId }) =>
    bodyStyles.has(styleId ?? ""),
  )?.sectionIndex;
  const lastSection = Math.max(
    0,
    ...inspection.blocks.map(({ sectionIndex }) => sectionIndex),
  );
  if (bodySection !== undefined && bodySection < lastSection) {
    findings.set("sections", {
      kind: "lastSectionNotBody",
      bodySection,
      lastSection,
    });
  }
  const health = [...findings.values()];
  // First, so the cap never drops it: it says more than any other.
  return (
    unread.length > 0
      ? [{ kind: "rolesNotRead" as const, roles: unread }, ...health]
      : health
  ).slice(0, HEALTH_FINDINGS_MAX);
};

/**
 * The list levels something of the template stands on: a style bound to
 * one, or a paragraph of the template numbered by one (a numbered line in
 * a letterhead the output keeps). Giving such a level another mark would
 * change what those print.
 */
const occupiedLevels = ({
  styles,
  blocks,
  numbering: { nums },
}: TemplateInspection): Set<string> => {
  const listOf = new Map(
    nums.map(({ numId, abstractNumId }) => [numId, abstractNumId]),
  );
  const occupied = new Set<string>();
  for (const { numPr } of styles) {
    const list = numPr === null ? undefined : listOf.get(numPr.numId);
    if (numPr !== null && list !== undefined) {
      occupied.add(`${String(list)}:${String(numPr.ilvl)}`);
    }
  }
  for (const { numbering } of blocks) {
    if (numbering !== null) {
      occupied.add(
        `${String(numbering.abstractNumId)}:${String(numbering.ilvl)}`,
      );
    }
  }
  return occupied;
};

/**
 * The deeper levels of another list of the template that nothing stands
 * on: none of the roles' lists, not the outline's, no level a style is
 * bound to or a paragraph of the template is numbered by.
 */
const inferMarkLevels = (
  inspection: TemplateInspection,
  roles: TemplateProfile["roles"],
  outlineLevel: ProfileListLevel | null,
): ProfileListLevel[] => {
  const numIdByList = new Map(
    inspection.numbering.nums.map(({ numId, abstractNumId }) => [
      abstractNumId,
      numId,
    ]),
  );
  const roleLists = new Set(
    Object.values(roles).flatMap((role) =>
      role?.numbering ? [role.numbering.abstractNumId] : [],
    ),
  );
  const markList = inspection.numbering.abstractNums.find(
    ({ abstractNumId, levels }) =>
      abstractNumId !== outlineLevel?.abstractNumId &&
      !roleLists.has(abstractNumId) &&
      numIdByList.has(abstractNumId) &&
      levels.length > 1 &&
      levels.every(({ ilvl, pStyle }) => ilvl === 0 || pStyle === null),
  );
  const markNumId =
    markList === undefined
      ? undefined
      : numIdByList.get(markList.abstractNumId);
  if (markList === undefined || markNumId === undefined) {
    return [];
  }
  const occupied = occupiedLevels(inspection);
  return markList.levels
    .filter(
      ({ ilvl }) =>
        ilvl > 0 &&
        !occupied.has(`${String(markList.abstractNumId)}:${String(ilvl)}`),
    )
    .map(({ ilvl, numFmt, lvlText, start, indent }) => ({
      numId: markNumId,
      ilvl,
      abstractNumId: markList.abstractNumId,
      numFmt,
      lvlText,
      start,
      indent,
    }));
};

/**
 * Infers a template's profile from its inspection. Deterministic: the same
 * template gives the same profile. Readings carry a confidence and their
 * evidence; a person confirms or corrects them before the profile is stored.
 */
/**
 * Whether the sample starts a page somewhere between its first block and
 * its first article: by a break among the runs, a paragraph's own page
 * start, or a section's end. Undefined when the sample has no article.
 */
const startsPageBeforeArticle = (
  topLevel: readonly DocxBlock[],
  article: ProfileRoleTarget | null,
): boolean | undefined => {
  const first = topLevel.findIndex(
    ({ kind, styleId }) => kind === "paragraph" && styleId === article?.styleId,
  );
  if (article === null || first <= 0) {
    return undefined;
  }
  return topLevel
    .slice(0, first + 1)
    .some(
      (block, position) =>
        (position > 0 && block.pageBreakBefore === true) ||
        (position < first &&
          ((block.pageBreaks ?? 0) > 0 || block.endsSection === true)),
    );
};

export const inferTemplateProfile = (
  inspection: TemplateInspection,
): TemplateProfile => {
  const facts = collectStyleFacts(inspection);
  const structure = readStructure(inspection.blocks);
  const roles = inferRoles(facts, structure.topLevel);
  const annexRoles = inferAnnexRoles(facts, roles);
  const partyHead = inferPartyHead(facts, roles);
  const samplesOf = (role: ProfileRoleTarget | null): readonly DocxBlock[] =>
    facts.find(({ style }) => style.styleId === role?.styleId)?.samples ??
    NO_BLOCKS;

  const paragraphs = inspection.blocks.filter(
    ({ kind }) => kind === "paragraph",
  );
  const numberedStyles = new Set(
    Object.values(roles).flatMap((role) =>
      role?.numbering ? [role.styleId] : [],
    ),
  );
  const numberedSamples = paragraphs.some(
    ({ label, styleId }) => label !== null && numberedStyles.has(styleId ?? ""),
  );
  const isNumberedSample = ({ label, styleId }: DocxBlock): boolean =>
    label !== null && numberedStyles.has(styleId ?? "");
  // Two texts side by side: every numbered sample paragraph sits in a table.
  const columnTable =
    numberedSamples && !structure.topLevel.some(isNumberedSample);

  const annexSamples = samplesOf(roles.annexHeading).filter(({ text }) =>
    ANNEX_SAMPLE.test(text),
  );
  const annexSample = annexSamples.at(0);
  let annex: TemplateProfile["annex"] = null;
  if (annexSample !== undefined) {
    const numberedByField = inspection.fields.some(
      ({ kind, blockId }) =>
        ANNEX_NUMBER_FIELDS.has(kind) && blockId === annexSample.id,
    );
    if (annexSample.label !== null) {
      annex = { numbering: "list" };
    } else {
      annex = { numbering: numberedByField ? "field" : "typed" };
    }
  }

  const outlineLevel =
    roles.articleHeading?.numbering ?? roles.clause1?.numbering ?? null;
  const boundLevels = new Set(
    facts.flatMap(({ level }) =>
      level !== null && level.abstractNumId === outlineLevel?.abstractNumId
        ? [level.ilvl]
        : [],
    ),
  );
  const deepest = Math.max(-1, ...boundLevels);
  const outlineList = inspection.numbering.abstractNums.find(
    ({ abstractNumId }) => abstractNumId === outlineLevel?.abstractNumId,
  );
  const spareLevels: ProfileListLevel[] =
    outlineLevel === null || outlineList === undefined
      ? []
      : outlineList.levels
          .filter(({ ilvl, pStyle }) => ilvl > deepest && pStyle === null)
          .map(({ ilvl, numFmt, lvlText, start, indent }) => ({
            numId: outlineLevel.numId,
            ilvl,
            abstractNumId: outlineLevel.abstractNumId,
            numFmt,
            lvlText,
            start,
            indent,
          }));

  const markLevels = inferMarkLevels(inspection, roles, outlineLevel);

  const tableText = inferTableText(
    facts,
    new Set(
      [...structure.nestedOf.values()].flatMap((blocks) =>
        blocks.map(({ id }) => id),
      ),
    ),
  );
  const regions = inferRegions({ inspection, structure, roles });
  const header = inferHeader(structure, regions.regions.keepBefore);
  const headerFields = inferHeaderFields(structure, regions.regions.keepBefore);
  const pageBeforeArticle = startsPageBeforeArticle(
    structure.topLevel,
    roles.articleHeading,
  );
  const kinds = [...new Set(inspection.fields.map(({ kind }) => kind))];
  const structural = STRUCTURAL_ROLES.map(
    (role) => roles[role]?.confidence ?? 0,
  );
  return {
    version: 1,
    templateSha256: inspection.sha256,
    layout: columnTable ? "parallelColumns" : "flow",
    roles,
    spareLevels,
    markLevels,
    ...regions,
    headings: {
      article: joinOf(
        samplesOf(roles.articleHeading).filter(({ label }) => label !== null),
      ),
      annex: joinOf(annexSamples),
    },
    ...(pageBeforeArticle === undefined
      ? {}
      : { frontMatterEndsPage: pageBeforeArticle }),
    ...(tableText === undefined ? {} : { tableText }),
    ...(header === undefined ? {} : { header }),
    ...(headerFields.length === 0 ? {} : { headerFields }),
    fields: {
      freezeKinds: kinds
        .filter((kind) => VOLATILE_FIELD_KINDS.has(kind))
        .toSorted(),
      liveKinds: kinds
        .filter((kind) => !VOLATILE_FIELD_KINDS.has(kind))
        .toSorted(),
    },
    fillerStrings: inferFillerStrings(inspection.blocks),
    annex,
    ...(annexRoles === undefined ? {} : { annexRoles }),
    ...(partyHead === undefined ? {} : { partyHead }),
    defaultAlignment:
      inspection.styles.find(
        ({ type, isDefault }) => type === "paragraph" && isDefault,
      )?.alignment ?? null,
    health: inferHealth(inspection, roles),
    // A template without sample text shows no role in use, and one whose
    // body runs in columns is not filled by column yet.
    confidence:
      Math.min(...structural) *
      (columnTable ? UNCERTAIN_SHARE : 1) *
      (numberedSamples ? 1 : UNCERTAIN_SHARE),
  };
};

type ProfileIssueCode =
  | "templateMismatch"
  | "missingBodyRole"
  | "unknownStyle"
  | "unknownListLevel"
  | "listLevelChanged"
  | "sharedListLevel"
  | "unknownBlock"
  | "fieldKeptInPart"
  | "headerFieldNotKept";

export type TemplateProfileIssue = {
  severity: "error" | "warning";
  code: ProfileIssueCode;
  role?: HouseStyleRole;
  blockId?: string;
};

/**
 * An issue for every role of the annexes' outline that names a style or a
 * list level the template does not have. The role on the issue is the one
 * the annex target stands in for.
 */
const annexRoleIssues = (
  { annexRoles }: TemplateProfile,
  inspection: TemplateInspection,
  {
    styles,
    abstractByNum,
  }: {
    styles: ReadonlySet<string>;
    abstractByNum: ReadonlyMap<number, number>;
  },
): TemplateProfileIssue[] => {
  const issues: TemplateProfileIssue[] = [];
  for (const role of OUTLINE_ROLES) {
    const roleTarget = annexRoles?.[role];
    if (roleTarget === undefined) {
      continue;
    }
    if (!styles.has(roleTarget.styleId)) {
      issues.push({ severity: "error", code: "unknownStyle", role });
    }
    const { numbering } = roleTarget;
    const known =
      numbering === null ||
      (abstractByNum.get(numbering.numId) === numbering.abstractNumId &&
        inspection.numbering.abstractNums.some(
          ({ abstractNumId, levels }) =>
            abstractNumId === numbering.abstractNumId &&
            levels.some(({ ilvl }) => ilvl === numbering.ilvl),
        ));
    if (!known) {
      issues.push({ severity: "error", code: "unknownListLevel", role });
    }
  }
  return issues;
};

/** An issue for every spare or mark level the template does not have. */
const unknownLevelIssues = (
  profile: TemplateProfile,
  inspection: TemplateInspection,
  abstractByNum: ReadonlyMap<number, number>,
): TemplateProfileIssue[] =>
  [...profile.spareLevels, ...(profile.markLevels ?? NO_LEVELS)].flatMap(
    ({ abstractNumId, numId, ilvl }): TemplateProfileIssue[] => {
      const known = inspection.numbering.abstractNums
        .find((list) => list.abstractNumId === abstractNumId)
        ?.levels.some((level) => level.ilvl === ilvl);
      return known === true && abstractByNum.get(numId) === abstractNumId
        ? []
        : [{ severity: "error", code: "unknownListLevel" }];
    },
  );

/**
 * A header field is filled in the front blocks the output keeps: the table
 * that holds its cells has to be one of them, or the lines the document
 * states for it would be taken from the body and placed nowhere.
 */
const headerFieldIssues = (
  { headerFields, regions: { keepBefore } }: TemplateProfile,
  nestedOf: ReadonlyMap<string, readonly DocxBlock[]>,
): TemplateProfileIssue[] =>
  (headerFields ?? NO_HEADER_FIELDS).flatMap(
    ({ labelBlockId, valueBlockId }) => {
      const kept = keepBefore.some((tableId) => {
        const inside = nestedOf.get(tableId) ?? NO_BLOCKS;
        return (
          inside.some(({ id }) => id === labelBlockId) &&
          inside.some(({ id }) => id === valueBlockId)
        );
      });
      return kept
        ? []
        : [
            {
              severity: "error" as const,
              code: "headerFieldNotKept" as const,
              blockId: valueBlockId,
            },
          ];
    },
  );

/**
 * An issue for every field over several blocks that the regions keep in
 * part: a field is kept whole, in one run and in its order, or not at all.
 * A table of contents that ends in the next heading's paragraph is kept
 * without it.
 */
const fieldsKeptInPart = (
  profile: TemplateProfile,
  inspection: TemplateInspection,
  { order, emitted }: { order: readonly string[]; emitted: readonly string[] },
): TemplateProfileIssue[] => {
  const issues: TemplateProfileIssue[] = [];
  for (const { kind, blockId, endBlockId } of inspection.fields) {
    if (blockId === undefined || endBlockId === undefined) {
      continue;
    }
    // A table of contents that ends in the next heading's paragraph is
    // kept without it.
    const tail =
      kind === CONTENTS_FIELD &&
      endBlockId !== blockId &&
      endsInNextHeading(
        inspection.blocks.find(({ id }) => id === endBlockId),
        profile.roles,
      ) &&
      !emitted.includes(endBlockId);
    const span = order.slice(
      order.indexOf(blockId),
      order.indexOf(endBlockId) + (tail ? 0 : 1),
    );
    const first = emitted.findIndex((id) => span.includes(id));
    const whole =
      first !== -1 &&
      span.every((id, offset) => emitted[first + offset] === id) &&
      emitted.filter((id) => span.includes(id)).length === span.length;
    if (first !== -1 && !whole) {
      issues.push({ severity: "error", code: "fieldKeptInPart", blockId });
    }
  }
  return issues;
};

/**
 * Checks a profile against the template it is used with: a stored profile
 * outlives edits to its template, and a corrected one may name a style the
 * template lacks. An `error` means no plan can be built from it.
 */
export const validateTemplateProfile = (
  profile: TemplateProfile,
  inspection: TemplateInspection,
): TemplateProfileIssue[] => {
  const issues: TemplateProfileIssue[] = [];
  if (profile.templateSha256 !== inspection.sha256) {
    issues.push({ severity: "error", code: "templateMismatch" });
  }
  if (profile.roles.body === null) {
    issues.push({ severity: "error", code: "missingBodyRole", role: "body" });
  }
  const facts = new Map(
    collectStyleFacts(inspection).map((fact) => [fact.style.styleId, fact]),
  );
  const abstractByNum = new Map(
    inspection.numbering.nums.map(({ numId, abstractNumId }) => [
      numId,
      abstractNumId,
    ]),
  );
  // A level set apart is placed in the style its finding names.
  for (const finding of profile.health ?? NO_FINDINGS) {
    if (
      finding.kind === "levelSetApart" &&
      !facts.has(finding.insteadStyleId)
    ) {
      issues.push({
        severity: "error",
        code: "unknownStyle",
        role: finding.role,
      });
    }
  }
  if (
    profile.tableText !== undefined &&
    !facts.has(profile.tableText.styleId)
  ) {
    issues.push({ severity: "error", code: "unknownStyle" });
  }
  const levelUsers = new Map<string, HouseStyleRole>();
  for (const role of HOUSE_STYLE_ROLES) {
    const roleTarget = profile.roles[role];
    if (roleTarget === null) {
      continue;
    }
    if (!facts.has(roleTarget.styleId)) {
      issues.push({ severity: "error", code: "unknownStyle", role });
    }
    const { numbering } = roleTarget;
    if (numbering === null) {
      continue;
    }
    const level = inspection.numbering.abstractNums
      .find(({ abstractNumId }) => abstractNumId === numbering.abstractNumId)
      ?.levels.find(({ ilvl }) => ilvl === numbering.ilvl);
    if (
      level === undefined ||
      abstractByNum.get(numbering.numId) !== numbering.abstractNumId
    ) {
      issues.push({ severity: "error", code: "unknownListLevel", role });
      continue;
    }
    if (
      level.numFmt !== numbering.numFmt ||
      level.lvlText !== numbering.lvlText
    ) {
      issues.push({ severity: "warning", code: "listLevelChanged", role });
    }
    const key = `${String(numbering.abstractNumId)}:${String(numbering.ilvl)}`;
    if (levelUsers.has(key)) {
      issues.push({ severity: "warning", code: "sharedListLevel", role });
    }
    levelUsers.set(key, role);
  }

  issues.push(...unknownLevelIssues(profile, inspection, abstractByNum));
  issues.push(
    ...annexRoleIssues(profile, inspection, {
      styles: new Set(facts.keys()),
      abstractByNum,
    }),
  );
  // The style for a party's numbered heading line is the template's too.
  if (
    profile.partyHead !== undefined &&
    !facts.has(profile.partyHead.styleId)
  ) {
    issues.push({ severity: "error", code: "unknownStyle", role: "party" });
  }

  const { topLevel, nestedOf } = readStructure(inspection.blocks);
  const order = topLevel.map(({ id }) => id);
  const { keepBefore, contents, filler } = profile.regions;
  const slotIds = [profile.slots.party, profile.slots.signature].flatMap(
    (slot) => (slot === null ? [] : slot.blockIds),
  );
  for (const blockId of [...keepBefore, ...contents, ...filler, ...slotIds]) {
    if (!order.includes(blockId)) {
      issues.push({ severity: "error", code: "unknownBlock", blockId });
    }
  }
  issues.push(...headerFieldIssues(profile, nestedOf));
  // Every region that keeps template blocks, in the order they are placed:
  // the front blocks, then the contents.
  issues.push(
    ...fieldsKeptInPart(profile, inspection, {
      order,
      emitted: [...keepBefore, ...contents],
    }),
  );
  return issues;
};

/** Longest style id, number format, level text or placeholder kept. */
const TEXT_MAX = 255;
/** A list has nine levels. */
const LEVELS_MAX = 9;
/** Blocks of one template a profile may name. */
const BLOCKS_MAX = 20_000;
const FILLER_STRINGS_MAX = 1000;
const FIELD_KINDS_MAX = 100;
/** The widest page WordprocessingML allows, in twentieths of a point. */
const INDENT_MAX = 31_680;

const textSchema = v.pipe(v.string(), v.maxLength(TEXT_MAX));
const idSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(TEXT_MAX));

/** An indent in twentieths of a point; a negative one reaches into the margin. */
const twipsSchema = v.nullable(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(-INDENT_MAX),
    v.maxValue(INDENT_MAX),
  ),
);

const listLevelSchema = v.strictObject({
  numId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  ilvl: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(LEVELS_MAX - 1),
  ),
  abstractNumId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  numFmt: textSchema,
  lvlText: textSchema,
  start: v.pipe(v.number(), v.integer(), v.minValue(0)),
  indent: v.strictObject({
    left: twipsSchema,
    hanging: twipsSchema,
    firstLine: twipsSchema,
  }),
});

const confidenceSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const roleTargetObjectSchema = v.strictObject({
  styleId: idSchema,
  alignment: v.nullable(textSchema),
  numbering: v.nullable(listLevelSchema),
  indentLeft: v.exactOptional(twipsSchema),
  size: v.exactOptional(v.nullable(v.pipe(v.number(), v.minValue(1)))),
  confidence: confidenceSchema,
  evidence: v.pipe(
    v.array(v.picklist(ROLE_EVIDENCE)),
    v.maxLength(ROLE_EVIDENCE.length),
  ),
});
const roleTargetSchema = v.nullable(roleTargetObjectSchema);

const blockIdsSchema = v.pipe(v.array(idSchema), v.maxLength(BLOCKS_MAX));
const slotSchema = v.nullable(v.strictObject({ blockIds: blockIdsSchema }));
const joinSchema = v.picklist(["sameLine", "lineBreak"]);
const fieldKindsSchema = v.pipe(
  v.array(
    v.pipe(v.string(), v.maxLength(TEXT_MAX), v.regex(/^[A-Z][A-Z0-9]*$/u)),
  ),
  v.maxLength(FIELD_KINDS_MAX),
);

const profileSchema = v.strictObject({
  version: v.literal(1),
  templateSha256: v.pipe(
    v.string(),
    v.maxLength(TEXT_MAX),
    v.regex(/^[0-9a-f]{64}$/u),
  ),
  layout: v.picklist(["flow", "parallelColumns"]),
  roles: v.strictObject({
    title: roleTargetSchema,
    party: roleTargetSchema,
    recital: roleTargetSchema,
    articleHeading: roleTargetSchema,
    clause1: roleTargetSchema,
    clause2: roleTargetSchema,
    clause3: roleTargetSchema,
    letter: roleTargetSchema,
    roman: roleTargetSchema,
    bullet: roleTargetSchema,
    continuation: roleTargetSchema,
    signature: roleTargetSchema,
    annexList: roleTargetSchema,
    annexHeading: roleTargetSchema,
    // A profile stored before the role was read has none.
    heading: v.optional(roleTargetSchema, null),
    body: roleTargetSchema,
  } satisfies Record<HouseStyleRole, unknown>),
  spareLevels: v.pipe(v.array(listLevelSchema), v.maxLength(LEVELS_MAX)),
  markLevels: v.exactOptional(
    v.pipe(v.array(listLevelSchema), v.maxLength(LEVELS_MAX)),
  ),
  regions: v.strictObject({
    keepBefore: blockIdsSchema,
    contents: blockIdsSchema,
    filler: blockIdsSchema,
  }),
  slots: v.strictObject({ party: slotSchema, signature: slotSchema }),
  partyHead: v.exactOptional(roleTargetObjectSchema),
  headings: v.strictObject({ article: joinSchema, annex: joinSchema }),
  frontMatterEndsPage: v.exactOptional(v.boolean()),
  contentsStyles: v.exactOptional(
    v.pipe(v.array(idSchema), v.maxLength(BLOCKS_MAX)),
  ),
  contentsDepth: v.exactOptional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9)),
  ),
  contentsLineStyles: v.exactOptional(
    v.pipe(
      v.array(
        v.strictObject({
          level: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9)),
          styleId: idSchema,
        }),
      ),
      v.maxLength(9),
    ),
  ),
  tableText: v.exactOptional(v.strictObject({ styleId: idSchema })),
  header: v.exactOptional(
    v.strictObject({
      addressee: v.pipe(v.array(idSchema), v.maxLength(HEADER_ADDRESSEE_MAX)),
      date: v.nullable(idSchema),
      reference: v.nullable(idSchema),
    }),
  ),
  headerFields: v.exactOptional(
    v.pipe(
      v.array(
        v.strictObject({
          field: v.picklist(HEAD_FIELDS),
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
          labelBlockId: idSchema,
          valueBlockId: idSchema,
        }),
      ),
      v.maxLength(HEAD_FIELDS.length),
    ),
  ),
  fields: v.strictObject({
    freezeKinds: fieldKindsSchema,
    liveKinds: fieldKindsSchema,
  }),
  fillerStrings: v.pipe(v.array(textSchema), v.maxLength(FILLER_STRINGS_MAX)),
  annex: v.nullable(
    v.strictObject({ numbering: v.picklist(["list", "field", "typed"]) }),
  ),
  annexRoles: v.exactOptional(
    v.strictObject({
      articleHeading: v.exactOptional(roleTargetObjectSchema),
      clause1: v.exactOptional(roleTargetObjectSchema),
      clause2: v.exactOptional(roleTargetObjectSchema),
      clause3: v.exactOptional(roleTargetObjectSchema),
      letter: v.exactOptional(roleTargetObjectSchema),
      roman: v.exactOptional(roleTargetObjectSchema),
    }),
  ),
  defaultAlignment: v.exactOptional(v.nullable(textSchema)),
  health: v.exactOptional(
    v.pipe(
      v.array(
        v.variant("kind", [
          v.strictObject({
            kind: v.literal("numberDrawnAsPicture"),
            abstractNumId: v.pipe(v.number(), v.integer()),
            ilvl: v.pipe(v.number(), v.integer(), v.minValue(0)),
          }),
          v.strictObject({
            kind: v.literal("textDrawnAsPicture"),
            styleId: v.nullable(textSchema),
          }),
          v.strictObject({
            kind: v.literal("headingStartsPage"),
            role: v.picklist(PAGE_ROLES),
            styleId: textSchema,
          }),
          v.strictObject({
            kind: v.literal("lastSectionNotBody"),
            bodySection: v.pipe(v.number(), v.integer(), v.minValue(0)),
            lastSection: v.pipe(v.number(), v.integer(), v.minValue(1)),
          }),
          v.strictObject({
            kind: v.literal("rolesNotRead"),
            roles: v.pipe(
              v.array(v.picklist(STRUCTURAL_ROLES)),
              v.minLength(1),
            ),
          }),
          v.strictObject({
            kind: v.literal("levelSetApart"),
            role: v.picklist(LEVEL_ROLES),
            styleId: textSchema,
            bold: v.boolean(),
            size: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
            insteadStyleId: textSchema,
          }),
        ]),
      ),
      v.maxLength(HEALTH_FINDINGS_MAX),
    ),
  ),
  levelLooks: v.exactOptional(v.picklist(["even", "asTemplate"])),
  confidence: confidenceSchema,
});

class TemplateProfileError extends TaggedError("TemplateProfileError")<{
  message: string;
}> {}

/** Reads a profile that was stored or edited outside this process. */
export const parseTemplateProfile = (
  input: unknown,
): Result<TemplateProfile, TemplateProfileError> => {
  const parsed = v.safeParse(profileSchema, input);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new TemplateProfileError({
          // The path only: an issue's message can quote the received value.
          message: `Template profile does not match its shape at ${v.getDotPath(parsed.issues[0]) ?? "the root"}`,
        }),
      );
};
