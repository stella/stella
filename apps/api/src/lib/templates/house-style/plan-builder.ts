// Turns the readings of one document (roles, its own numbering, its
// cross-references) and a template profile into the plan the engine applies.
// The plan carries block ids, styles, list levels and spans, never text: the
// engine copies the text from the source and refuses a plan that would lose
// or change any of it.
//
// Numbering keeps the source's designators by default. A template level is
// patched to print what the source prints (`Článek %1.` in roman numerals
// where the template has `Čl. %1`), each numbered paragraph restarts its
// level wherever the source's count differs, and a label no level can print
// stays typed text in an unnumbered paragraph.

import { panic } from "better-result";

import {
  roleItemId,
  scopeItemId,
  targetItemId,
} from "@/api/lib/templates/house-style/ambiguity";
import { closeNumberParts } from "@/api/lib/templates/house-style/designators";
import { isStrippableLabel } from "@/api/lib/templates/house-style/folio-contract";
import type {
  DocxBlock,
  DocxBlockManifest,
  DocxSection,
  TemplatePlan,
  TemplatePlanAlignment,
  TemplatePlanHighlight,
  TemplatePlanIndent,
  TemplatePlanNestedParagraph,
  TemplatePlanNumbering,
  TemplatePlanNumberingPatch,
  TemplatePlanReference,
  TemplatePlanSection,
  TemplatePlanSourceItem,
  TrackedChanges,
  TrackedChangesView,
} from "@/api/lib/templates/house-style/folio-contract";
import {
  buildLabelIndex,
  isRunningText,
  printedLabel,
} from "@/api/lib/templates/house-style/label-index";
import type {
  LabelEntry,
  LabelIndex,
} from "@/api/lib/templates/house-style/label-index";
import { readLetterHead } from "@/api/lib/templates/house-style/letter-head";
import {
  levelsInLanguage,
  numberPlacements,
  ordinalOf,
  patternOf,
  plannedLabelOf,
} from "@/api/lib/templates/house-style/plan-numbering";
import type {
  LabelKeptReason,
  ListLevelFormat,
  NumberingMode,
  OutlineLevels,
  Placement,
  PlanLanguages,
} from "@/api/lib/templates/house-style/plan-numbering";
import type { DetectedReference } from "@/api/lib/templates/house-style/reference-detector";
import {
  selectLabelField,
  selectReferenceField,
  showsBareNumber,
} from "@/api/lib/templates/house-style/reference-fields";
import type { ReferenceSuspicion } from "@/api/lib/templates/house-style/reference-suspicions";
import {
  HOUSE_STYLE_ROLES,
  isBlankParagraph,
  isBulleted,
  isSetAsTitle,
} from "@/api/lib/templates/house-style/role-proposer";
import type {
  HouseStyleRole,
  RoleProposal,
} from "@/api/lib/templates/house-style/role-proposer";
import { LEVEL_ROLES } from "@/api/lib/templates/house-style/template-profile";
import type {
  ProfileListLevel,
  ProfileRoleTarget,
  TemplateHealthFinding,
  TemplateProfile,
} from "@/api/lib/templates/house-style/template-profile";

/** The share of automatic labels that may go unread before a reference
 *  without a target stops being marked as one. */
const UNREAD_LABELS_SHARE_MAX = 0.2;

/** Highlights for a reference that reads as internal and has no target to
 *  link, most wanted first. The document's own highlights mark blanks to
 *  fill; the first colour it does not use tells the two apart. */
const UNRESOLVED_REFERENCE_HIGHLIGHTS = [
  "cyan",
  "magenta",
  "green",
  "yellow",
  "red",
  "lightGray",
] as const;

type UnlinkedReason =
  /** The document has no provision the designator names. */
  | "unresolved"
  /** Several provisions fit and none was chosen. */
  | "ambiguous"
  /** Internal or external was not decided. */
  | "undecidedScope"
  /** The target keeps its typed label, or has none a field could show. */
  | "targetNotNumbered"
  /** The target is an annex whose number is typed text: no field can keep
   *  a reference to it current (a bookmark around typed digits goes stale
   *  without a sign when a digit is typed at its end). */
  | "annexTyped"
  /** The field would show another text than the source prints. */
  | "designatorMismatch"
  /** The target's level prints words with punctuation (`Čl. 3`,
   *  `Příloha č. 2`); a field drops the words and keeps the punctuation,
   *  so it would show `.2`. And the citation does not print those words
   *  itself (`článku 3`), so no field stands for word and number either. */
  | "punctuatedLevelWords"
  /** The citation prints the label's words in a spelling no field gives
   *  back: lower case in front of a roman number (`čl. IV`). */
  | "caseNotReproducible"
  /** The citation prints the label's words with another blank than the
   *  label (a no-break space for a plain one); a field would change it. */
  | "blankDiffers"
  /** The reference stands in the paragraph it names. */
  | "sameParagraph"
  /** The span cannot carry a field: it lies in a stripped label or in a
   *  block the plan does not place, or the engine refused it. */
  | "notPlaceable";

export type FormattingNoteItem =
  | {
      kind: "referenceUnlinked";
      blockId: string;
      start: number;
      end: number;
      reason: UnlinkedReason;
      highlighted: boolean;
      /** The house scheme gave the cited provision another number and no
       *  field stands in for the typed one: the citation reads wrong until
       *  a person corrects it. Always highlighted. */
      targetRenumbered?: true;
    }
  | {
      kind: "referenceSuspected";
      blockId: string;
      start: number;
      end: number;
      citedBlockId: string;
      suggestedBlockId: string;
      confidence: number;
    }
  /** A typed label stays text; the paragraph joins no list. */
  | { kind: "labelKeptAsText"; blockId: string; reason: LabelKeptReason }
  /** Automatic numbering converted to text: no list of the template prints
   *  the label, so it is written in front of the paragraph, which joins no
   *  list. */
  | { kind: "labelConvertedToText"; blockId: string; reason: LabelKeptReason }
  | { kind: "roleWithoutStyle"; role: HouseStyleRole; blocks: number }
  /** The source tracked changes and was formatted in one view of them: the
   *  output carries no revision. `stated` is false when nobody chose and
   *  every change was accepted. */
  | ({
      kind: "trackedChangesResolved";
      view: TrackedChangesView;
      stated: boolean;
    } & TrackedChanges)
  /** `blocks` paragraphs numbered like articles are running text: they
   *  keep their numbers and are set as clauses, not as headings. */
  | { kind: "articlesSetAsText"; blocks: number }
  /** The source starts a page in front of this block and the output does
   *  not: a table cannot be told to start one. */
  | { kind: "pageStartNotKept"; blockId: string; reason: "table" }
  /** The source starts a page between an article's heading and the block
   *  it heads. The output starts it in front of the heading (`blockId`):
   *  a heading does not end a page. */
  | { kind: "pageStartMoved"; blockId: string; fromBlockId: string }
  /** The source starts a page in front of this block and the output does
   *  not. `opensNoPart`: the block opens no part of the document (a title
   *  page, an article, an annex, the signatures, a section), so the start
   *  was there to fit the source's pages and would leave a page part empty.
   *  `templateFlowsOn`: the start stood between the front matter and the
   *  first article, where the template's own sample runs on. */
  | {
      kind: "pageStartDropped";
      blockId: string;
      reason: "opensNoPart" | "templateFlowsOn";
    }
  /** A section of the source ends after this block and the next one's
   *  layout is not carried over: it begins on the same page (`continuous`,
   *  `nextColumn`), or its page or its columns are other than the
   *  document's first section has. A section that begins on a new page
   *  still begins one. */
  | {
      kind: "sectionLayoutNotKept";
      afterBlockId: string;
      start: DocxSection["start"];
      pageDiffers: boolean;
      columns: number;
    }
  /** The output keeps the spacing of a justified line that ends in a
   *  manual line break, which the template's settings would stretch to the
   *  margin: because the source's settings kept it (`source`), or because
   *  `blocks` paragraphs with such a break are justified here and were not
   *  in the source, or got their break by being joined (`justifiedHere`).
   *  The setting is the document's: `alreadyStretched` paragraphs showed
   *  the stretched line in the source and lose it with the others. */
  | {
      kind: "lineBreakSpacingKept";
      reason: "source" | "justifiedHere";
      blocks: number;
      alreadyStretched: number;
    }
  /** The template carries text effects that show nothing on `levels` list
   *  levels and `styles` styles, which would have their text drawn as a
   *  picture; the output is written without them, so numbers and text are
   *  text. The template's own findings are in its profile. */
  | { kind: "invisibleEffectsRemoved"; levels: number; styles: number }
  /** The template's style for a numbered level sets it apart from its
   *  sibling levels (bold, or another size). `blocks` paragraphs of the
   *  role were placed in the sibling's style instead, on their own level of
   *  the list. */
  | {
      kind: "levelStyleEvened";
      role: HouseStyleRole;
      styleId: string;
      insteadStyleId: string;
      blocks: number;
    }
  /** `blocks` lines that head the paragraph after them without being set
   *  as headings (a provision that is only a title, a heading of the source
   *  placed as text) stay on the page of that paragraph. */
  | { kind: "linesKeptWithNext"; blocks: number }
  /** A letter's closing was kept together: `blocks` paragraphs (the end of
   *  the text, the line the letter closes with, the signatory's lines) stay
   *  on one page, so no name stands alone on a last page. */
  | { kind: "closingKeptTogether"; blocks: number }
  /** `blocks` paragraphs whose number is text hang like the paragraphs the
   *  list numbers on their level: the number stands out, the text is
   *  aligned under itself. */
  | { kind: "textLabelsHung"; blocks: number }
  /** `blocks` headings the source breaks behind their number are set on
   *  one line, as the template sets its headings: the line break went with
   *  the typed number. */
  | { kind: "headingBreaksDropped"; blocks: number }
  /** `blocks` lines of the parties (`IČO:`, a tab, the value) got one tab
   *  stop behind the widest label of their block, so the values start at
   *  one position. The text is as it was. */
  | { kind: "partyLinesAligned"; blocks: number }
  /** `blocks` lines without a number that the source sets under the text
   *  of a numbered item stand under that item's text here too, not at the
   *  indent of unnumbered text. */
  | { kind: "continuationsIndented"; blocks: number }
  /** `blocks` lines keep the alignment the source sets them in: short
   *  centred or right-aligned lines in front of the first article, and the
   *  text of table cells. The template's text styles set every line at the
   *  left. */
  | { kind: "alignmentsKept"; blocks: number }
  /** The letterhead the template keeps: `filled` cells took the letter's
   *  own addressee, date or reference; `left` cells still show the
   *  template's sample text, because the letter states nothing for them,
   *  and have to be filled in by hand. */
  | {
      kind: "letterheadFilled";
      filled: ("addressee" | "date" | "reference")[];
      left: ("addressee" | "date" | "reference")[];
    }
  /** `blocks` paragraphs whose number the source types with a blank
   *  between its parts (`1. 1.`) are numbered by the list, which prints the
   *  number closed up (`1.1.`). */
  | { kind: "numberPartsClosed"; blocks: number }
  /** The template is in other languages (`template`) than the document
   *  (`document`). The document's own numbers and words stay; `labelLevels`
   *  levels of the template's own scheme print their label word in the
   *  document's language. What the template itself prints (a footer) is
   *  the template's. */
  | {
      kind: "templateLanguageDiffers";
      document: string;
      template: string[];
      labelLevels: number;
    }
  | {
      kind: "templateBlocksKept";
      region: "keepBefore" | "contents";
      blockIds: string[];
    };

/** What was done and what a person should look at. Ids, enums and counts:
 *  the wording is the caller's, in the reader's language. */
export type FormattingNote = {
  mode: NumberingMode;
  counts: {
    placed: number;
    omitted: number;
    numbered: number;
    /** Paragraphs whose automatic label is written as text. */
    labelsConvertedToText: number;
    /** Paragraphs told to start a page, for a page the source started by a
     *  break that is not placed. */
    pageStarts: number;
    /** Sections of the source that stay sections, for a page other than
     *  the first section's. */
    sectionsKept: number;
    numberingPatches: number;
    referencesLinked: number;
    referencesUnlinked: number;
    referencesHighlighted: number;
  };
  items: FormattingNoteItem[];
};

/** What an earlier attempt showed the engine will not take; the plan is
 *  rebuilt without it. */
type PlanExclusions = {
  /** Blocks that keep their label as text and join no list. */
  numbering: ReadonlySet<string>;
  /** Blocks whose references and highlights are left out. */
  marks: ReadonlySet<string>;
  /** Blocks no reference may point to. */
  targets: ReadonlySet<string>;
  /** Headings that are not joined with their title paragraph. */
  merges: ReadonlySet<string>;
};

export const NO_EXCLUSIONS: PlanExclusions = {
  numbering: new Set(),
  marks: new Set(),
  targets: new Set(),
  merges: new Set(),
};

/** A table whose cells the plan places as they are. */
const NO_NESTED: readonly TemplatePlanNestedParagraph[] = [];
const NO_SECTIONS: readonly DocxSection[] = [];
const NO_HEALTH: readonly TemplateHealthFinding[] = [];

const CLAUSE_ROLES = ["clause1", "clause2", "clause3"] as const;

/** Where a role without a style of its own lands, nearest first. */
const STYLE_FALLBACK = {
  title: ["body"],
  party: ["body"],
  recital: ["body"],
  articleHeading: ["title", "body"],
  clause1: ["continuation", "body"],
  clause2: ["clause1", "continuation", "body"],
  clause3: ["clause2", "clause1", "continuation", "body"],
  letter: ["continuation", "body"],
  roman: ["letter", "continuation", "body"],
  bullet: ["continuation", "body"],
  continuation: ["body"],
  signature: ["body"],
  annexList: ["body"],
  annexHeading: ["title", "body"],
  // A template without a style for headings that carry no number sets them
  // as text, kept with what they head.
  heading: ["continuation", "body"],
  body: [],
} as const satisfies Record<HouseStyleRole, readonly HouseStyleRole[]>;

/** Roles whose numbered style is for numbered paragraphs only: a recital
 *  without a letter is body text, not an empty list item. */
const NUMBERED_ONLY: ReadonlySet<HouseStyleRole> = new Set(["recital"]);

const isHouseStyleRole = (value: string): value is HouseStyleRole =>
  HOUSE_STYLE_ROLES.some((role) => role === value);

type BuildOptions = {
  manifest: DocxBlockManifest;
  profile: TemplateProfile;
  references: readonly DetectedReference[];
  roles: readonly RoleProposal[];
  mode: NumberingMode;
  /** Pass the index when the caller already built one from this manifest. */
  index?: LabelIndex;
  /** Accepted answers to the open decisions, by item id. */
  decisions?: ReadonlyMap<string, string>;
  suspicions?: readonly ReferenceSuspicion[];
  exclusions?: PlanExclusions;
  /** The highlight colours the source's own text carries. */
  sourceHighlightColors: readonly string[];
  /** Whether the caller chose the view of the source's tracked changes;
   *  the note says when nobody did. */
  trackedChangesStated?: boolean;
  /** The languages of the document and of the template, when the caller
   *  knows them. */
  languages?: PlanLanguages;
};

/** A placed paragraph that would not show the label the source shows. */
export type PlannedLabelIssue = {
  blockId: string;
  /** `lost`: it would show none. `differs`: its list would print another. */
  kind: "lost" | "differs";
};

type BuiltPlan = {
  plan: TemplatePlan;
  note: FormattingNote;
  /** Empty for a plan that keeps every label; a plan with an entry here is
   *  not to be applied. */
  labelsNotKept: PlannedLabelIssue[];
};

/** What every step of one build reads. */
type Context = {
  blocks: readonly DocxBlock[];
  blockById: ReadonlyMap<string, DocxBlock>;
  /** The table a cell paragraph sits in. */
  tableOf: ReadonlyMap<string, string>;
  topLevel: readonly DocxBlock[];
  /** The source's sections; empty when the manifest does not report them. */
  sections: readonly DocxSection[];
  /** The sections of the source that stay sections: their last paragraph
   *  and what the plan says of each, and the one the body ends with. */
  keptSections: KeptSections;
  index: LabelIndex;
  profile: TemplateProfile;
  mode: NumberingMode;
  exclusions: PlanExclusions;
  decisions: ReadonlyMap<string, string>;
  proposalById: ReadonlyMap<string, RoleProposal>;
  outline: OutlineLevels;
  /** Blocks placed under a role the template has no style for. */
  stylelessRoles: Map<HouseStyleRole, number>;
  items: FormattingNoteItem[];
  /** What goes into the template's letterhead; null without one or
   *  without a letter. */
  headerFill: HeaderFill | null;
};

type KeptSections = {
  ends: ReadonlyMap<string, TemplatePlanSection>;
  last: TemplatePlanSection | undefined;
};

const NO_KEPT_SECTIONS: KeptSections = { ends: new Map(), last: undefined };

/** Every paragraph inside a table, cells of nested tables included. */
const insideOf = (
  table: DocxBlock,
  blockById: ReadonlyMap<string, DocxBlock>,
): DocxBlock[] =>
  table.cells === undefined
    ? []
    : table.cells
        .flatMap(({ blockIds }) => blockIds)
        .flatMap((id) => {
          const inner = blockById.get(id);
          return inner === undefined
            ? []
            : [inner, ...insideOf(inner, blockById)];
        });

/**
 * The style a level the template sets apart from its siblings is placed
 * in: the sibling's, unless the profile keeps the template's looks.
 */
const evenedStyle = (
  { profile }: Context,
  role: HouseStyleRole,
  own: ProfileRoleTarget,
): ProfileRoleTarget => {
  if (profile.levelLooks === "asTemplate") {
    return own;
  }
  const finding = (profile.health ?? NO_HEALTH).find(
    (candidate) =>
      candidate.kind === "levelSetApart" &&
      candidate.role === role &&
      candidate.styleId === own.styleId,
  );
  if (finding?.kind !== "levelSetApart") {
    return own;
  }
  const sibling = LEVEL_ROLES.map((level) => profile.roles[level]).find(
    (target) => target?.styleId === finding.insteadStyleId,
  );
  return {
    ...own,
    styleId: finding.insteadStyleId,
    alignment: sibling?.alignment ?? own.alignment,
  };
};

const styleTarget = (
  context: Context,
  role: HouseStyleRole,
): ProfileRoleTarget | null => {
  const { profile, stylelessRoles } = context;
  const own = profile.roles[role];
  if (own !== null) {
    return evenedStyle(context, role, own);
  }
  stylelessRoles.set(role, (stylelessRoles.get(role) ?? 0) + 1);
  for (const fallback of STYLE_FALLBACK[role]) {
    const target = profile.roles[fallback];
    if (target !== null) {
      return evenedStyle(context, fallback, target);
    }
  }
  return null;
};

/**
 * The level a role without one of its own stands beside: the level of the
 * role whose style it borrows. A bullet borrows the style of unnumbered
 * text, which has no level; it hangs where the template's lettered items
 * do, from the start of the text they belong to.
 */
const borrowedLevelOf = (
  profile: TemplateProfile,
  target: ProfileRoleTarget | null,
  bulleted: boolean,
): ProfileListLevel | null =>
  target?.numbering ??
  (bulleted ? (profile.roles.letter?.numbering ?? null) : null);

/**
 * Whether a paragraph numbered like an article is running text and no
 * heading: clause `1.` of an agreement without headings, a numbered
 * paragraph of a schedule. A heading whose title stands in the next
 * paragraph is one.
 */
const runsOn = (block: DocxBlock, entry: LabelEntry | null): boolean =>
  entry?.titleBlockId === null &&
  isRunningText(block.text.slice(entry.manualLength));

/** What a level must print for a bullet to keep its mark: the mark, and
 *  the text face it is a character of. */
const bulletPatternOf = (
  { numbering }: DocxBlock,
  mark: string,
): NonNullable<Placement["pattern"]> => {
  const font = numbering?.bulletFont;
  return font === undefined
    ? { numFmt: "bullet", lvlText: mark }
    : { numFmt: "bullet", lvlText: mark, font };
};

/** One paragraph's style and what it asks of the numbering. */
const placementOf = (
  context: Context,
  block: DocxBlock,
  role: HouseStyleRole,
): Placement => {
  const { index, profile, exclusions, outline } = context;
  const entry = index.entryByBlockId.get(block.id) ?? null;
  const own = profile.roles[role];
  const ownLevel = own?.numbering ?? null;
  // Running text numbered like an article keeps the article's level, and
  // with it its number, and reads as the clause it is.
  const styleRole =
    role === "articleHeading" && runsOn(block, entry) ? "clause1" : role;
  const target =
    entry === null && ownLevel !== null && NUMBERED_ONLY.has(role)
      ? styleTarget(context, "body")
      : styleTarget(context, styleRole);
  const mark = (block.label ?? "").trim();
  const bulleted = entry === null && isBulleted(block);
  const placement: Placement = {
    block,
    role,
    entry,
    styleId: target?.styleId ?? null,
    level: entry === null && !bulleted ? null : ownLevel,
    borrowedLevel:
      ownLevel === null ? borrowedLevelOf(profile, target, bulleted) : null,
    sourceLabel: null,
    pattern: null,
    ordinal: null,
    numbered: false,
    restartFrom: null,
    group: null,
    counters: [],
    keptReason: null,
  };
  if (exclusions.numbering.has(block.id)) {
    placement.keptReason =
      entry !== null || printedLabel(block) !== null ? "excluded" : null;
    return placement;
  }
  if (entry === null) {
    // A bulleted paragraph keeps its mark: on the template's bullet level,
    // or on a spare one.
    if (bulleted) {
      placement.sourceLabel = mark;
      placement.pattern = bulletPatternOf(block, mark);
      placement.numbered = true;
    }
    return placement;
  }
  const lead = block.text.length - block.text.trimStart().length;
  // A number a field in the text counts goes with the text: the paragraph
  // keeps its name and the field, and joins no list.
  if (entry.origin === "field") {
    placement.sourceLabel = block.text.slice(lead, entry.manualLength).trim();
    placement.level = null;
    placement.keptReason = "noListLevel";
    return placement;
  }
  const sourceLabel =
    entry.origin === "auto"
      ? mark
      : block.text.slice(lead, lead + entry.shape.length);
  placement.sourceLabel = sourceLabel;
  if (
    entry.origin === "manual" &&
    !isStrippableLabel(sourceLabel, block.text)
  ) {
    placement.keptReason = "notStrippable";
    return placement;
  }
  placement.pattern = patternOf(entry, sourceLabel, outline);
  placement.ordinal =
    placement.pattern === null
      ? null
      : ordinalOf(entry, placement.pattern.numFmt);
  // A typed label of a role the template numbers no level for (an annex
  // heading) would take a spare level only to be cited by fields. Where a
  // field could not show its bare number, the label stays typed text.
  if (
    ownLevel === null &&
    entry.origin === "manual" &&
    placement.pattern !== null &&
    !showsBareNumber(placement.pattern.lvlText)
  ) {
    placement.keptReason = "noListLevel";
    return placement;
  }
  placement.numbered = true;
  return placement;
};

type Placed = {
  placements: Placement[];
  placementById: Map<string, Placement>;
  /** A split heading's title paragraph, by the heading it joins. */
  titleOf: Map<string, DocxBlock>;
  /** The heading a joined title paragraph ends up in. */
  mergedInto: Map<string, string>;
  omitted: Map<string, "empty" | "sourceToc">;
  /** Placed paragraphs that start a page. */
  pageStarts: Set<string>;
  /** Placed paragraphs that stay on the page of the one after them. */
  keptWithNext: Set<string>;
  /** The paragraphs of a letter's closing that stay with the next one. */
  closingLines: Set<string>;
  /** The tab stops placed paragraphs get of their own. */
  tabStops: Map<string, number[]>;
  /** Where the lines of a paragraph set under an item start. */
  itemIndents: Map<string, number>;
  /** The alignment placed paragraphs keep from the source. */
  alignments: Map<string, TemplatePlanAlignment>;
};

const roleOf = (
  { decisions, proposalById }: Context,
  block: DocxBlock,
): HouseStyleRole | null => {
  const decided = decisions.get(roleItemId(block.id));
  if (decided !== undefined && isHouseStyleRole(decided)) {
    return decided;
  }
  return proposalById.get(block.id)?.role ?? null;
};

/**
 * The blank paragraphs that stay: the first one after a table that only
 * blank paragraphs part from the next table or from the document's end.
 * Two tables with nothing between them are one table to a word processor,
 * and a document's last block has to be a paragraph.
 */
const tableSeparators = (
  context: Context,
  pageHolders: ReadonlySet<string>,
): Set<string> => {
  const { topLevel, index } = context;
  const separators = new Set<string>();
  /** Whether only blank paragraphs came since the last table. */
  let afterTable = false;
  let firstBlank: string | null = null;
  /** A blank paragraph of the gap stays anyway, to start the page: it
   *  parts the tables, and one kept paragraph per gap is enough. */
  let held = false;
  const keep = () => {
    if (afterTable && firstBlank !== null && !held) {
      separators.add(firstBlank);
    }
  };
  for (const block of topLevel) {
    if (block.kind === "table") {
      keep();
      afterTable = true;
      firstBlank = null;
      held = false;
      continue;
    }
    if (!afterTable || index.contentsBlockIds.has(block.id)) {
      continue;
    }
    if (roleOf(context, block) === null && isBlankParagraph(block)) {
      firstBlank ??= block.id;
      held ||= pageHolders.has(block.id);
      continue;
    }
    afterTable = false;
  }
  keep();
  return separators;
};

const NEW_PAGE_STARTS: ReadonlySet<DocxSection["start"]> = new Set([
  "nextPage",
  "evenPage",
  "oddPage",
]);

/** The section that begins after `block`, when `block` ends one. */
const sectionAfter = (
  { sections }: Context,
  block: DocxBlock,
): DocxSection | undefined =>
  block.endsSection === true
    ? sections.find(({ index }) => index === block.sectionIndex + 1)
    : undefined;

/** Whether the block after `block` opens a section on a new page that
 *  nothing else starts: a section that stays a section starts its own. */
const endsPage = (context: Context, block: DocxBlock): boolean => {
  const next = sectionAfter(context, block);
  return (
    next !== undefined &&
    NEW_PAGE_STARTS.has(next.start) &&
    !context.keptSections.ends.has(block.id)
  );
};

/** Whether a paragraph that is left out starts a page by what it holds. */
const breaksPage = ({ pageBreaks = 0, pageBreakBefore }: DocxBlock): boolean =>
  pageBreaks > 0 || pageBreakBefore === true;

/**
 * The blank paragraphs that stay because the source starts a page in front
 * of a table: a table cannot be told to start one, so the last blank
 * paragraph in front of it stays and starts the page, by the break it holds
 * or by being told to.
 */
const pageHoldersBeforeTables = (context: Context): Set<string> => {
  const { topLevel, index } = context;
  const holders = new Set<string>();
  let pending = false;
  let placedAny = false;
  let lastBlank: string | null = null;
  for (const block of topLevel) {
    if (block.kind === "table") {
      if (pending && placedAny && lastBlank !== null) {
        holders.add(lastBlank);
      }
      pending = false;
      placedAny = true;
      lastBlank = null;
    } else if (index.contentsBlockIds.has(block.id)) {
      pending ||= breaksPage(block);
    } else if (roleOf(context, block) === null && isBlankParagraph(block)) {
      pending ||= breaksPage(block);
      lastBlank = block.id;
    } else {
      pending = false;
      placedAny = true;
      lastBlank = null;
    }
    pending ||= endsPage(context, block);
  }
  return holders;
};

/**
 * The blank paragraph that stays because the source starts a page in front
 * of its own table of contents and the plan keeps the template's in its
 * place: kept template blocks cannot be told to start a page, so the last
 * blank paragraph in front of the source's contents stays and starts it.
 * Null when the template keeps no contents, the source has none, or no page
 * starts in front of them.
 */
const pageHolderBeforeContents = (context: Context): string | null => {
  const { topLevel, index, profile } = context;
  if (profile.regions.contents.length === 0) {
    return null;
  }
  let pending = false;
  let placedAny = false;
  let lastBlank: string | null = null;
  for (const block of topLevel) {
    if (index.contentsBlockIds.has(block.id)) {
      return pending && placedAny ? lastBlank : null;
    }
    if (
      block.kind === "paragraph" &&
      roleOf(context, block) === null &&
      isBlankParagraph(block)
    ) {
      pending ||= breaksPage(block);
      lastBlank = block.id;
    } else {
      pending = false;
      placedAny = true;
      lastBlank = null;
    }
    pending ||= endsPage(context, block);
  }
  return null;
};

/**
 * The blocks in front of which the source starts a page, by its facts
 * alone and before anything is placed: a page break in a blank paragraph
 * or in a line of the source's contents passes to the block after it, as
 * does a section that ends on a new page.
 */
const pageStartsInSource = (context: Context): Set<string> => {
  const starts = new Set<string>();
  let pending = false;
  for (const block of context.topLevel) {
    const passesOn =
      block.kind === "paragraph" &&
      (isBlankParagraph(block) || context.index.contentsBlockIds.has(block.id));
    if (passesOn) {
      pending ||= breaksPage(block);
    } else {
      if (pending || block.pageBreakBefore === true) {
        starts.add(block.id);
      }
      pending = false;
    }
    const next = sectionAfter(context, block);
    pending ||= next !== undefined && NEW_PAGE_STARTS.has(next.start);
  }
  return starts;
};

/** Whether a section's page is another than the document's first has. */
const pageDiffersFrom = (
  base: DocxSection | undefined,
  { orientation, size }: DocxSection,
): boolean =>
  base !== undefined &&
  (base.orientation !== orientation ||
    base.size.width !== size.width ||
    base.size.height !== size.height);

/** The page of a section for a plan, when it is another than the first
 *  section's: `undefined` when it is the same, null when the section does
 *  not state the size of its page. */
const plannedPage = (
  base: DocxSection | undefined,
  section: DocxSection,
): TemplatePlanSection["page"] | null => {
  if (!pageDiffersFrom(base, section)) {
    return undefined;
  }
  const { width, height } = section.size;
  if (width === null || height === null) {
    return null;
  }
  const { top, right, bottom, left } = section.margins;
  return {
    orientation: section.orientation,
    width,
    height,
    ...(top === null || right === null || bottom === null || left === null
      ? {}
      : { margins: { top, right, bottom, left } }),
  };
};

/** A section of a plan: the page when it is another, and an even or odd
 *  start, which the default does not give. */
const plannedSection = (
  page: TemplatePlanSection["page"],
  start: DocxSection["start"] | undefined,
): TemplatePlanSection => ({
  ...(page === undefined ? {} : { page }),
  ...(start === "evenPage" || start === "oddPage" ? { start } : {}),
});

/**
 * The sections of the source that stay sections in the output: those whose
 * page is another than the first section's (a landscape annex), and their
 * neighbours, which have to end where such a page begins. Every other
 * section end becomes a page start, or nothing, so a section of the output
 * can span several of the source: it begins as the first of them does. A
 * section ends with the paragraph that ended it in the source; when one of
 * those cannot carry it (it is a line of the source's contents, or joins
 * its heading), no section is kept and the note lists what was lost.
 */
const sectionsToKeep = (context: Context): KeptSections => {
  const { sections, topLevel, index, proposalById } = context;
  const base = sections.at(0);
  const differs = sections.map((section) => pageDiffersFrom(base, section));
  if (!differs.includes(true)) {
    return NO_KEPT_SECTIONS;
  }
  const ends = new Map<string, TemplatePlanSection>();
  /** The source section the output section in progress began with. */
  let opened = base;
  for (const [position, section] of sections.entries()) {
    const page = plannedPage(base, section);
    if (page === null) {
      return NO_KEPT_SECTIONS;
    }
    if (position === sections.length - 1) {
      const last = plannedSection(page, opened?.start);
      return { ends, last: Object.keys(last).length === 0 ? undefined : last };
    }
    if (!(differs[position] === true || differs[position + 1] === true)) {
      continue;
    }
    const carrier = topLevel.find(
      (block) =>
        block.kind === "paragraph" &&
        block.endsSection === true &&
        block.sectionIndex === section.index,
    );
    if (
      carrier === undefined ||
      index.contentsBlockIds.has(carrier.id) ||
      (proposalById.get(carrier.id)?.mergedIntoBlockId ?? null) !== null
    ) {
      return NO_KEPT_SECTIONS;
    }
    // The document's first section begins the document, whatever it says.
    ends.set(
      carrier.id,
      plannedSection(page, ends.size === 0 ? undefined : opened?.start),
    );
    opened = sections[position + 1];
  }
  return NO_KEPT_SECTIONS;
};

/** Notes the section that begins after `block` when its layout does not
 *  come along: it begins on the same page, or its page or columns are
 *  other than the document's first section has. */
const noteSectionAfter = (context: Context, block: DocxBlock): void => {
  const next = sectionAfter(context, block);
  if (next === undefined) {
    return;
  }
  const base = context.sections.at(0);
  // A section that stays a section keeps its page and its start.
  const kept = context.keptSections.ends.has(block.id);
  const pageDiffers = !kept && pageDiffersFrom(base, next);
  if (
    (!kept && !NEW_PAGE_STARTS.has(next.start)) ||
    pageDiffers ||
    next.columns !== (base?.columns ?? 1)
  ) {
    context.items.push({
      kind: "sectionLayoutNotKept",
      afterBlockId: block.id,
      start: next.start,
      pageDiffers,
      columns: next.columns,
    });
  }
};

/**
 * The placed paragraphs in front of which the source starts a page by
 * something the plan does not place: a page break in a paragraph that is
 * left out, the paragraph's own formatting, or a section that begins on a
 * new page. A paragraph that is placed carries the breaks among its runs
 * itself.
 */
const pageStartsOf = (
  context: Context,
  placed: Placed,
  holders: ReadonlySet<string>,
  contentsHolder: string | null,
): Set<string> => {
  const starts = new Set<string>();
  /** A page start waits for the next block that is placed. */
  let pending = false;
  /** Nothing starts a page in front of the document's first block. */
  let placedAny = false;
  /** Whether anything was placed in front of the paragraph placed last. */
  let placedBeforeLast = false;
  /** A kept blank paragraph starts the page in front of the table that
   *  follows: every start between the two is that one. */
  let held = false;
  for (const block of context.topLevel) {
    noteSectionAfter(context, block);
    if (block.kind === "table") {
      if (pending && placedAny) {
        context.items.push({
          kind: "pageStartNotKept",
          blockId: block.id,
          reason: "table",
        });
      }
      pending = false;
      placedAny = true;
      held = false;
      continue;
    }
    if (holders.has(block.id) || block.id === contentsHolder) {
      // It was kept because the page starts in front of the table, by a
      // break before it, behind it or in the section it closes. With a
      // break of its own among its runs it needs no telling.
      if ((block.pageBreaks ?? 0) === 0) {
        starts.add(block.id);
      }
      pending = false;
      placedAny = true;
      // The one in front of the contents starts their page only: a page
      // the source starts behind its contents starts behind the kept ones.
      held = block.id !== contentsHolder;
      continue;
    }
    if (placed.omitted.has(block.id)) {
      pending ||= !held && breaksPage(block);
    } else if (placed.mergedInto.has(block.id)) {
      // A title joined to its heading has no paragraph to start a page:
      // the heading it joined starts it.
      const head = placed.mergedInto.get(block.id);
      if ((pending || block.pageBreakBefore === true) && head !== undefined) {
        if (placedBeforeLast) {
          starts.add(head);
        }
        context.items.push({
          kind: "pageStartMoved",
          blockId: head,
          fromBlockId: block.id,
        });
      }
      pending = false;
    } else {
      if ((pending || block.pageBreakBefore === true) && placedAny) {
        starts.add(block.id);
      }
      pending = false;
      placedBeforeLast = placedAny;
      placedAny = true;
      held = false;
    }
    pending ||= !held && endsPage(context, block);
  }
  return starts;
};

/** The roles that open a part of the document on a page of its own. */
const PAGE_OPENING_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  "title",
  "articleHeading",
  "annexHeading",
]);

const FRONT_MATTER_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  "title",
  "party",
]);

/** Whether a paragraph may begin a page because of what it is. */
const opensPage = (
  { role, block }: Placement,
  before: Placement | null,
): boolean =>
  PAGE_OPENING_ROLES.has(role) ||
  isSetAsTitle(block) ||
  (role === "signature" && before?.role !== "signature") ||
  (before !== null &&
    FRONT_MATTER_ROLES.has(before.role) &&
    !FRONT_MATTER_ROLES.has(role));

/** A page of the source with less text than this was cut short on
 *  purpose (a title page, a page of signatures): its end is no accident
 *  of the source's pagination. A full page of a contract holds three to
 *  four times as much. */
const SHORT_PAGE_CHARS = 1200;

/**
 * Keeps a page start only where a part of the document begins: in front
 * of a title, an article or an annex, in front of the signatures, behind
 * the title page, behind a page the source cut short, and where a section
 * of the source begins on a new page. A start anywhere else was set to
 * fit the source's pages; in the template's type and margins it would
 * leave a page part empty. It is dropped and the note names the block. A
 * blank paragraph kept to start the page in front of a table is not
 * touched.
 */
const dropLoosePageStarts = (
  context: Context,
  placed: Placed,
  holders: ReadonlySet<string>,
): void => {
  let before: Placement | null = null;
  let sectionBegins = false;
  /** The text of the source since its last page start. */
  let pageChars = 0;
  /** Whether the first article is still to come. */
  let frontMatter = context.profile.frontMatterEndsPage === false;
  for (const block of context.topLevel) {
    const placement =
      block.kind === "table" ? undefined : placed.placementById.get(block.id);
    const starts = placed.pageStarts.has(block.id);
    const droppable =
      placement !== undefined &&
      starts &&
      !holders.has(block.id) &&
      !sectionBegins;
    // Between the front matter and the first article the template decides:
    // where its own sample runs on, so does the document.
    const flowsOn =
      placement !== undefined &&
      frontMatter &&
      (placement.role === "articleHeading" ||
        (before !== null &&
          FRONT_MATTER_ROLES.has(before.role) &&
          !FRONT_MATTER_ROLES.has(placement.role)));
    if (droppable && flowsOn) {
      placed.pageStarts.delete(block.id);
      context.items.push({
        kind: "pageStartDropped",
        blockId: block.id,
        reason: "templateFlowsOn",
      });
    } else if (
      droppable &&
      pageChars >= SHORT_PAGE_CHARS &&
      !opensPage(placement, before)
    ) {
      placed.pageStarts.delete(block.id);
      context.items.push({
        kind: "pageStartDropped",
        blockId: block.id,
        reason: "opensNoPart",
      });
    }
    frontMatter &&= placement?.role !== "articleHeading";
    // The page is measured from where the source starts it: a start moved
    // in front of a heading does not make the heading part of that page.
    pageChars =
      starts || block.pageBreakBefore === true || (block.pageBreaks ?? 0) > 0
        ? 0
        : pageChars;
    pageChars += [block, ...insideOf(block, context.blockById)].reduce(
      (sum, { text }) => sum + text.trim().length,
      0,
    );
    if (placement === undefined) {
      before = block.kind === "table" ? null : before;
      sectionBegins ||= endsPage(context, block);
    } else {
      before = placement;
      sectionBegins = endsPage(context, block);
    }
  }
};

/** The roles whose paragraphs a list numbers level by level. */
const HANGING_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  ...LEVEL_ROLES,
  "recital",
]);

/**
 * The indent of a paragraph whose number is text: the one its level gives
 * the paragraphs it numbers, so the number stands where theirs do and the
 * text is aligned under itself. Null for a paragraph without a label, for
 * a heading, and where the level states no hanging indent.
 */
const hangOf = (
  { profile }: Context,
  { block, entry, level, borrowedLevel, role }: Placement,
): TemplatePlanIndent | null => {
  const labelled = entry !== null || shownLabelOf(block) !== null;
  const provision =
    HANGING_ROLES.has(role) ||
    (role === "articleHeading" && runsOn(block, entry));
  if (!labelled || !provision) {
    return null;
  }
  const beside =
    level ?? borrowedLevel ?? profile.roles[role]?.numbering ?? null;
  const left = beside?.indent.left ?? null;
  const hanging = beside?.indent.hanging ?? null;
  return left === null || hanging === null || hanging <= 0
    ? null
    : { left, hanging };
};

/** Where the text of a placed paragraph starts, from the left margin. */
const textStartOf = (context: Context, placement: Placement): number => {
  const { profile } = context;
  const { entry, level, borrowedLevel, role, pattern } = placement;
  const numberedAt = level ?? borrowedLevel;
  // A bullet has no entry of its own: its text starts where its level's.
  if ((entry !== null || pattern?.numFmt === "bullet") && numberedAt !== null) {
    return numberedAt.indent.left ?? 0;
  }
  // A number written as text hangs as a list's would.
  const hang = hangOf(context, placement);
  if (hang?.left !== undefined) {
    return hang.left;
  }
  // Unnumbered text of a provision stands under the text of its clause.
  return role === "continuation"
    ? (profile.roles.clause1?.numbering?.indent.left ?? 0)
    : 0;
};

/**
 * A bullet that borrows its level hangs from the paragraph its list
 * belongs to: its mark stands where that paragraph's text starts, its text
 * one hanging step further.
 */
const hangBullet = (
  context: Context,
  bullet: Placement,
  lead: Placement | null,
): void => {
  const beside = bullet.borrowedLevel;
  if (beside === null || bullet.pattern?.numFmt !== "bullet" || lead === null) {
    return;
  }
  const step = beside.indent.hanging ?? beside.indent.left ?? 0;
  if (step <= 0) {
    return;
  }
  bullet.borrowedLevel = {
    ...beside,
    indent: {
      left: textStartOf(context, lead) + step,
      hanging: step,
      firstLine: null,
    },
  };
};

const HEADING_TEXT_MAX = 160;

/**
 * Whether a paragraph read as an article's heading is one on the page: a
 * label with a title, not a numbered paragraph of running text (clause
 * `1.` of an agreement without headings).
 */
const headsText = (
  { titleOf }: Placed,
  { role, block, entry }: Placement,
): boolean => {
  if (role !== "articleHeading") {
    return false;
  }
  const text = block.text.slice(entry?.manualLength ?? 0).trim();
  return (
    titleOf.has(block.id) ||
    (text.length <= HEADING_TEXT_MAX && !/[.;:,]$/u.test(text))
  );
};

/**
 * Moves a page start that falls between an article's heading and the block
 * it heads in front of the heading: a heading does not end a page. Several
 * heading lines in a row (a heading and a title that could not join it)
 * move as one. Nothing starts a page in front of the document's first
 * block, so a start behind a heading that opens the document is dropped.
 */
const keepHeadingsWithBody = (context: Context, placed: Placed): void => {
  /** The heading lines placed last, with nothing placed after them. */
  let headings: string[] = [];
  let placedBefore = false;
  let placedBeforeHeadings = false;
  for (const block of context.topLevel) {
    if (block.kind === "table") {
      headings = [];
      placedBefore = true;
      continue;
    }
    const placement = placed.placementById.get(block.id);
    if (placement === undefined) {
      continue;
    }
    const first = headings.at(0);
    if (first !== undefined && placed.pageStarts.has(block.id)) {
      placed.pageStarts.delete(block.id);
      if (placedBeforeHeadings) {
        placed.pageStarts.add(first);
      }
      context.items.push({
        kind: "pageStartMoved",
        blockId: first,
        fromBlockId: block.id,
      });
    }
    if (headsText(placed, placement)) {
      if (headings.length === 0) {
        placedBeforeHeadings = placedBefore;
      }
      headings.push(block.id);
    } else {
      headings = [];
    }
    placedBefore = true;
  }
};

/** A line of a label, tabs and a value: `IČO:`, a tab, the number. */
const LABELLED_LINE = /^(?<label>[^\t\n]{1,40})(?<tabs>\t+)\S/u;
/** The same outside the parties' block, where only a label that ends in a
 *  colon tells such a line from text with a tab in it. */
const COLON_LABEL = /:[ \u00A0]*$/u;
/** The width of an average character, as a share of the font's size. */
const CHARACTER_WIDTH = 0.55;
/** The size text is taken to have where the template states none, in
 *  half-points. */
const TEXT_SIZE = 22;
/** The space between the widest label and the values, in twentieths of a
 *  point. */
const LABEL_GAP = 170;
/** The tabs a line types in front of its last one end a point apart in
 *  front of the shared stop, so the last tab of every line ends at it. */
const TAB_STEP = 20;
/** As many stops as fit in the gap behind the widest label: a source that
 *  tabbed its values into place over default stops types that many. */
const TAB_STOPS_MAX = 8;

type LabelledLine = { blockId: string; labelEnd: number; tabs: number };

/** Where a party line's label ends, from the left margin, and how many
 *  tabs follow it; null for a line without the shape or a style whose
 *  indent is not known. */
const labelledLine = (
  { profile }: Context,
  { block, styleId, role, numbered }: Placement,
): LabelledLine | null => {
  const read = LABELLED_LINE.exec(block.text)?.groups;
  const parts =
    read !== undefined &&
    !numbered &&
    block.label === null &&
    (role === "party" || COLON_LABEL.test(read["label"] ?? ""))
      ? read
      : undefined;
  const style = Object.values(profile.roles).find(
    (target) => target?.styleId === styleId,
  );
  const indentLeft = style?.indentLeft;
  if (parts === undefined || indentLeft === undefined) {
    return null;
  }
  const width =
    (parts["label"] ?? "").length *
    (style?.size ?? TEXT_SIZE) *
    10 *
    CHARACTER_WIDTH;
  return {
    blockId: block.id,
    labelEnd: (indentLeft ?? 0) + Math.ceil(width),
    tabs: (parts["tabs"] ?? "").length,
  };
};

/**
 * Gives the lines of a label, a tab and a value one tab stop behind the
 * widest label of their block: the details of the parties, and such lines
 * anywhere else. The template's style for them has no stop of its own, so
 * a tab ends at the next default stop and every value starts where its
 * label happens to end. A block is the paragraphs in one style that follow
 * each other; a table, a paragraph a list numbers and another style end
 * it. The text stays as it is.
 */
const alignPartyLines = (context: Context, placed: Placed): void => {
  let run: LabelledLine[] = [];
  let style: string | null = null;
  const close = (): void => {
    if (run.length >= 2) {
      const first =
        Math.max(...run.map(({ labelEnd }) => labelEnd)) + LABEL_GAP;
      for (const { blockId, tabs } of run) {
        // As many stops as the line has tabs, the last one the shared one.
        const count = Math.min(Math.max(tabs, 1), TAB_STOPS_MAX);
        placed.tabStops.set(
          blockId,
          Array.from(
            { length: count },
            (_, index) => first - (count - 1 - index) * TAB_STEP,
          ),
        );
      }
    }
    run = [];
  };
  for (const block of context.topLevel) {
    const placement =
      block.kind === "table" ? undefined : placed.placementById.get(block.id);
    if (placement === undefined) {
      // A paragraph that is left out parts nothing; a table does.
      if (block.kind === "table") {
        close();
      }
      continue;
    }
    if (
      placement.styleId !== style ||
      placement.numbered ||
      block.label !== null
    ) {
      close();
      style = placement.styleId;
    }
    const line = labelledLine(context, placement);
    if (line !== null) {
      run.push(line);
    }
  }
  close();
};

/** How far left of an item's text a line may start and still stand under
 *  it: a millimetre, in twentieths of a point. */
const UNDER_ITEM_TOLERANCE = 60;

const ITEM_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  ...LEVEL_ROLES,
  "recital",
  "bullet",
]);

const UNNUMBERED_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  "continuation",
  "body",
  "annexList",
]);

/** Whether a placed paragraph shows a number or a mark a list prints, or
 *  one that is to be: a typed label that stays typed is text of its line
 *  (`Příloha č. 1 – Ceník` in a list of annexes). */
const showsLabel = ({ entry, block, numbered }: Placement): boolean =>
  (entry !== null && numbered) || shownLabelOf(block) !== null;

/** Whether a line can have others set under its text. */
const leadsLines = ({ role, pattern }: Placement): boolean =>
  ITEM_ROLES.has(role) || pattern?.numFmt === "bullet";

/**
 * Whether the source sets an unnumbered line under the text of the item in
 * front of it: its first line starts where the item's text does, or
 * further in.
 */
const standsUnder = (line: Placement, item: Placement): boolean => {
  const own = line.block.indent;
  const above = item.block.indent;
  return (
    own !== undefined &&
    above !== undefined &&
    above.left > 0 &&
    // A line that hangs a mark of its own in front (a box, a dash) starts
    // at that mark.
    own.left + own.firstLine >= above.left - UNDER_ITEM_TOLERANCE
  );
};

/**
 * Sets the unnumbered lines that continue a numbered item under that
 * item's text: the address lines under `(i)`, a second paragraph of a
 * lettered point. The template's style for unnumbered text has one indent,
 * made for text under a clause; under a deeper item it would stand left of
 * the text it belongs to. A table, a heading and a paragraph the source
 * sets further out end the item.
 */
const indentContinuations = (context: Context, placed: Placed): void => {
  let item: Placement | null = null;
  for (const block of context.topLevel) {
    const placement =
      block.kind === "table" ? undefined : placed.placementById.get(block.id);
    if (placement === undefined) {
      item = block.kind === "table" ? null : item;
      continue;
    }
    if (showsLabel(placement)) {
      item = leadsLines(placement) ? placement : null;
      continue;
    }
    if (
      item !== null &&
      UNNUMBERED_ROLES.has(placement.role) &&
      standsUnder(placement, item)
    ) {
      placed.itemIndents.set(block.id, textStartOf(context, item));
    } else {
      item = null;
    }
  }
};

/** The longest line that keeps the alignment the source sets it in. */
const SET_LINE_MAX = 160;

/** Roles of running text in front of the provisions. */
const FRONT_TEXT_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  "body",
  "continuation",
  "party",
]);

/** The alignment a source paragraph is set apart by, or undefined. */
const setApartOf = ({
  alignment,
}: DocxBlock): TemplatePlanAlignment | undefined =>
  alignment === "center" || alignment === "right" ? alignment : undefined;

/**
 * Keeps short lines in front of the first article where the source sets
 * them: centred (the line in brackets under the title, an `a` between two
 * parties) or at the right margin (`- dále jen „Strana 1“ -`). The text
 * styles of a template set every line at the left; these lines are laid
 * out by hand in the firm's own documents too. A document without article
 * headings has no such front matter and keeps its styles' alignment.
 */
const alignFrontLines = (context: Context, placed: Placed): void => {
  const firstArticle = placed.placements.find(
    ({ role }) => role === "articleHeading",
  );
  if (firstArticle === undefined) {
    return;
  }
  for (const block of context.topLevel) {
    if (block.index >= firstArticle.block.index) {
      return;
    }
    const placement =
      block.kind === "table" ? undefined : placed.placementById.get(block.id);
    const alignment = setApartOf(block);
    if (
      placement !== undefined &&
      alignment !== undefined &&
      FRONT_TEXT_ROLES.has(placement.role) &&
      !showsLabel(placement) &&
      block.text.trim().length <= SET_LINE_MAX &&
      !block.text.includes("\t")
    ) {
      placed.alignments.set(block.id, alignment);
      // Set between the margins, not inside the indent of a text style.
      placement.styleId =
        context.profile.roles.body?.styleId ?? placement.styleId;
    }
  }
};

const TITLE_LINE_MAX = 80;

/** How deep a provision stands; a role outside the provisions has none. */
const PROVISION_DEPTH: Partial<Record<HouseStyleRole, number>> = {
  articleHeading: 0,
  clause1: 1,
  clause2: 2,
  clause3: 3,
  letter: 4,
  roman: 5,
  bullet: 6,
};

/**
 * Whether a line heads the paragraph after it without being set as a
 * heading: a provision that is one short line in front of the provisions
 * under it (`2. Implementation plan` in front of `2.1`), or a heading of
 * the source placed as text. A heading's own style keeps a heading with
 * its text; these lines have a text style, which does not.
 */
const headsNext = (
  placed: Placed,
  line: Placement,
  next: Placement,
): boolean => {
  const { role, block, entry } = line;
  const heading =
    role === "articleHeading"
      ? headsText(placed, line)
      : role === "annexHeading" || role === "title";
  const text = block.text.slice(entry?.manualLength ?? 0).trim();
  // A paragraph read as a heading without a number heads what follows it
  // whatever its length or first letter: the reading already judged those.
  if (role === "heading" && text !== "") {
    return true;
  }
  if (
    heading ||
    text === "" ||
    text.length > TITLE_LINE_MAX ||
    !/^[\p{Lu}\p{N}§]/u.test(text) ||
    /[;,]$/u.test(text)
  ) {
    return false;
  }
  // A heading without a number may be set in a text style, where the
  // template has none for it.
  if (
    role === "heading" ||
    (block.outlineLevel !== null && !/[.:]$/u.test(text))
  ) {
    return true;
  }
  const own = PROVISION_DEPTH[role];
  const under = PROVISION_DEPTH[next.role];
  return (
    entry !== null && own !== undefined && under !== undefined && under > own
  );
};

/**
 * The lines that stay on the page of the paragraph after them. Not a line
 * in front of a table or of a page start, nor the last of a section.
 */
const keepLinesWithBody = (context: Context, placed: Placed): void => {
  let line: Placement | null = null;
  for (const block of context.topLevel) {
    if (block.kind === "table") {
      line = null;
      continue;
    }
    const next = placed.placementById.get(block.id);
    if (next === undefined) {
      continue;
    }
    if (
      line !== null &&
      !placed.pageStarts.has(block.id) &&
      !context.keptSections.ends.has(line.block.id) &&
      headsNext(placed, line, next)
    ) {
      placed.keptWithNext.add(line.block.id);
    }
    line = next;
  }
};

/** The line a letter closes with: `S pozdravem`, `Yours sincerely`, `Mit
 *  freundlichen Grüßen`, with or without its comma. */
const VALEDICTION =
  /^(?:s[ \u00A0](?:(?:přátelským|uctivým|srdečným)[ \u00A0])?(?:pozdravem|pozdravom)|s[ \u00A0](?:veškerou[ \u00A0])?úctou|s[ \u00A0]přáním[ \u00A0].{1,40}|yours[ \u00A0](?:sincerely|faithfully|truly)|(?:kind|best|warm)[ \u00A0]regards|sincerely(?:[ \u00A0]yours)?|mit[ \u00A0](?:freundlichen|besten|herzlichen)[ \u00A0]grüßen|hochachtungsvoll)[,.!]?$/iu;
/** The lines a closing has at most under the line it closes with, and how
 *  long such a line is: a name, a function, a firm. */
const CLOSING_LINES_MAX = 6;
const CLOSING_LINE_MAX = 80;

/**
 * A letter's closing stays on one page: the line the letter closes with,
 * the signatory's lines under it, and the end of the paragraph in front of
 * them. Otherwise a name can stand alone on a last page. A closing is read
 * only at the end of the document: nothing but a few short lines follows the
 * line it closes with, and no table.
 */
const keepClosingTogether = (context: Context, placed: Placed): void => {
  let lines: DocxBlock[] = [];
  let closesAt = -1;
  for (const block of context.topLevel) {
    // A table ends what could close with the lines behind it: the
    // paragraph in front of the table stays with the table, not with them.
    if (block.kind === "table") {
      lines = [];
      closesAt = -1;
      continue;
    }
    if (!placed.placementById.has(block.id)) {
      continue;
    }
    if (VALEDICTION.test(block.text.trim())) {
      closesAt = lines.length;
    }
    lines.push(block);
  }
  const under = closesAt === -1 ? [] : lines.slice(closesAt + 1);
  if (
    closesAt === -1 ||
    under.length > CLOSING_LINES_MAX ||
    under.some(({ text }) => text.trim().length > CLOSING_LINE_MAX)
  ) {
    return;
  }
  // The paragraph in front of the closing keeps its last lines with it.
  for (const [position, line] of lines.entries()) {
    const next = lines[position + 1];
    if (
      position >= closesAt - 1 &&
      next !== undefined &&
      !placed.pageStarts.has(next.id) &&
      !context.keptSections.ends.has(line.id)
    ) {
      placed.closingLines.add(line.id);
    }
  }
};

/** A placement for every paragraph that gets one, in document order. */
const placeParagraphs = (context: Context): Placed => {
  const { topLevel, blockById, index, exclusions, proposalById } = context;
  const pageHolders = pageHoldersBeforeTables(context);
  const contentsHolder = pageHolderBeforeContents(context);
  // A blank paragraph that ends a section which stays one carries it.
  const kept = new Set([
    ...tableSeparators(context, pageHolders),
    ...pageHolders,
    ...(contentsHolder === null ? [] : [contentsHolder]),
    ...context.keptSections.ends.keys(),
  ]);
  const startsPage = pageStartsInSource(context);
  const placed: Placed = {
    placements: [],
    placementById: new Map(),
    titleOf: new Map(),
    mergedInto: new Map(),
    omitted: new Map(),
    pageStarts: new Set(),
    keptWithNext: new Set(),
    closingLines: new Set(),
    tabStops: new Map(),
    itemIndents: new Map(),
    alignments: new Map(),
  };
  /** The paragraph placed last at the top level; a table ends the run. */
  let lastPlaced: string | null = null;
  /** The paragraph in front of a list of bullets. */
  let lead: Placement | null = null;
  for (const block of topLevel) {
    if (block.kind === "table") {
      lastPlaced = null;
      lead = null;
      for (const inner of insideOf(block, blockById)) {
        const role = inner.kind === "paragraph" ? roleOf(context, inner) : null;
        // A cell paragraph without a reading is placed with its table.
        if (role !== null) {
          placed.placements.push(placementOf(context, inner, role));
        }
      }
      continue;
    }
    if (index.contentsBlockIds.has(block.id)) {
      placed.omitted.set(block.id, "sourceToc");
      continue;
    }
    const role = roleOf(context, block);
    if (role === null && isBlankParagraph(block) && !kept.has(block.id)) {
      placed.omitted.set(block.id, "empty");
      continue;
    }
    const head = proposalById.get(block.id)?.mergedIntoBlockId ?? null;
    const headBlock = head === null ? undefined : blockById.get(head);
    // An article's heading takes the page start with it: the page starts
    // in front of the heading, and the title joins it as on any page.
    const movesWithHead =
      headBlock !== undefined &&
      roleOf(context, headBlock) === "articleHeading";
    if (
      head !== null &&
      lastPlaced === head &&
      !placed.titleOf.has(head) &&
      !exclusions.merges.has(head) &&
      // Any other title that starts a page is a line of its own: joined to
      // its heading it would stay on the page before. So is one behind the
      // end of a section that stays a section: it belongs to the next.
      (movesWithHead || !startsPage.has(block.id)) &&
      !context.keptSections.ends.has(head)
    ) {
      placed.mergedInto.set(block.id, head);
      placed.titleOf.set(head, block);
      continue;
    }
    const placement = placementOf(context, block, role ?? "body");
    if (head !== null) {
      // A title that could not join its heading is a heading line of its
      // own, without a number.
      placement.numbered = false;
      placement.level = null;
      placement.keptReason = null;
    }
    if (placement.pattern?.numFmt === "bullet") {
      hangBullet(context, placement, lead);
    } else {
      lead = placement;
    }
    placed.placements.push(placement);
    lastPlaced = block.id;
  }
  for (const placement of placed.placements) {
    placed.placementById.set(placement.block.id, placement);
  }
  placed.pageStarts = pageStartsOf(
    context,
    placed,
    pageHolders,
    contentsHolder,
  );
  keepHeadingsWithBody(context, placed);
  dropLoosePageStarts(context, placed, pageHolders);
  keepLinesWithBody(context, placed);
  keepClosingTogether(context, placed);
  alignPartyLines(context, placed);
  indentContinuations(context, placed);
  alignFrontLines(context, placed);
  return placed;
};

const numberingOf = ({
  numbered,
  level,
  restartFrom,
  group,
}: Placement): TemplatePlanNumbering | null =>
  numbered && level !== null
    ? {
        numId: level.numId,
        ilvl: level.ilvl,
        ...(restartFrom === null ? {} : { restartFrom }),
        ...(group === null ? {} : { group }),
      }
    : null;

/** The automatic label a block shows, or null when it shows none. */
const shownLabelOf = ({ label }: DocxBlock): string | null => {
  const shown = (label ?? "").trim();
  return shown === "" ? null : shown;
};

/** An automatic label is never dropped: where no list prints it, it is
 *  written as text. */
const asTextOf = (
  block: DocxBlock,
  numbering: TemplatePlanNumbering | null,
): { labelAsText?: true } =>
  numbering === null && shownLabelOf(block) !== null
    ? { labelAsText: true }
    : {};

const stripOf = ({
  numbered,
  entry,
  sourceLabel,
}: Placement): { stripLabel?: string } =>
  numbered && entry?.origin === "manual" && sourceLabel !== null
    ? { stripLabel: sourceLabel }
    : {};

/** A line break right behind a label, with the blank in front of it. */
const BREAK_BEHIND_LABEL = /^[ \t\u00A0]*\n/u;

/**
 * Whether a heading's line break behind its number goes with the stripped
 * number: the template sets number and title on one line, and the template
 * wins over the author's break.
 */
const dropsLabelBreak = (
  profile: TemplateProfile,
  placement: Placement,
): boolean => {
  const { role, block, entry } = placement;
  const join =
    role === "annexHeading" ? profile.headings.annex : profile.headings.article;
  return (
    (role === "articleHeading" || role === "annexHeading") &&
    join === "sameLine" &&
    stripOf(placement).stripLabel !== undefined &&
    BREAK_BEHIND_LABEL.test(block.text.slice(entry?.manualLength ?? 0))
  );
};

/**
 * Whether the document breaks its headings after the number, where the
 * template leaves that to the document: a heading split over two
 * paragraphs then joins the way the document's other headings read. Where
 * the template's sample heading sets number and title on one line, every
 * heading does.
 */
const breaksHeadings = (
  { headings: { article } }: TemplateProfile,
  { placements, titleOf }: Placed,
): boolean => {
  if (article === "sameLine") {
    return false;
  }
  const headings = placements.filter(
    ({ role, entry }) => role === "articleHeading" && entry !== null,
  );
  const broken = headings.filter(({ block, entry }) =>
    block.text.slice(entry?.manualLength ?? 0).startsWith("\n"),
  ).length;
  return broken > headings.length - broken - titleOf.size;
};

/**
 * Settles the heading level for headings that break after the number.
 *
 * Where the document writes its headings so, a tab after the number would
 * push the title's line off the heading's alignment; a space still parts the
 * number from a title on the same line.
 *
 * A centred heading is centred between its indents. The left and hanging
 * indent of its level, made for a number that stands in the margin, move
 * every line after a break off the first line's centre, so the level gets
 * none as soon as one of its headings holds a break.
 */
const settleBrokenHeadings = (
  { profile }: Context,
  { placements, titleOf }: Placed,
  patches: TemplatePlanNumberingPatch[],
  breaks: boolean,
): void => {
  const heading = profile.roles.articleHeading;
  const level = heading?.numbering ?? null;
  if (heading === null || level === null) {
    return;
  }
  // Only paragraphs set as headings are centred.
  const onLevel = placements.filter(
    (placement) =>
      placement.numbered &&
      placement.level === level &&
      placement.styleId === heading.styleId,
  );
  const { left, hanging } = level.indent;
  const offCentre =
    heading.alignment === "center" &&
    ((left !== null && left !== 0) || (hanging !== null && hanging !== 0)) &&
    onLevel.some(
      (placement) =>
        // A break that goes with the stripped number breaks nothing.
        placement.block.text
          .slice(placement.entry?.manualLength ?? 0)
          .replace(
            dropsLabelBreak(profile, placement) ? BREAK_BEHIND_LABEL : /^$/u,
            "",
          )
          .includes("\n") ||
        (breaks && titleOf.has(placement.block.id)),
    );
  if (onLevel.length === 0 || (!breaks && !offCentre)) {
    return;
  }
  const patch = patches.find(
    ({ abstractNumId, ilvl }) =>
      abstractNumId === level.abstractNumId && ilvl === level.ilvl,
  );
  const settled: TemplatePlanNumberingPatch = {
    ...(patch ?? { abstractNumId: level.abstractNumId, ilvl: level.ilvl }),
    ...(breaks ? { suff: "space" } : {}),
    ...(offCentre ? { indent: { left: 0, hanging: 0 } } : {}),
  };
  if (patch === undefined) {
    patches.push(settled);
  } else {
    patches.splice(patches.indexOf(patch), 1, settled);
  }
};

/**
 * The style of a cell paragraph. A line of the parties laid out in a table
 * has its place by its cell: the indent the template gives such a line on
 * the page would only narrow the column, so it takes the plain text style.
 */
const cellStyleOf = (
  { profile }: Context,
  { role, styleId }: Placement,
): string | null =>
  role === "party" ? (profile.roles.body?.styleId ?? styleId) : styleId;

/** The roles of cell paragraphs that are lines of text laid out by their
 *  table: where the source centres one or sets it at the right, it stays. */
const CELL_TEXT_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  "party",
  "body",
  "continuation",
  "signature",
]);

const tableItem = (
  context: Context,
  { placementById }: Placed,
  table: DocxBlock,
): TemplatePlanSourceItem => {
  const { blockById } = context;
  const nested: TemplatePlanNestedParagraph[] = [];
  for (const inner of insideOf(table, blockById)) {
    const placement = placementById.get(inner.id);
    if (placement !== undefined) {
      const numbering = numberingOf(placement);
      const styleId = cellStyleOf(context, placement);
      // A line of text keeps its place in the cell whether it was read as
      // a party's line or not; a provision takes its style's.
      const alignment =
        CELL_TEXT_ROLES.has(placement.role) && inner.text.trim() !== ""
          ? setApartOf(inner)
          : undefined;
      nested.push({
        blockId: inner.id,
        ...(styleId === null ? {} : { styleId }),
        numbering,
        ...stripOf(placement),
        ...asTextOf(inner, numbering),
        ...(alignment === undefined ? {} : { alignment }),
      });
    } else if (inner.kind === "paragraph") {
      // A cell paragraph placed with its table takes the style the
      // template writes its tables in. It joins no list of the template;
      // a number it shows goes with it as text.
      // Where its text stands in the cell is the table's own layout: a
      // centred row that heads a group, an amount at the right.
      const styleId = context.profile.tableText?.styleId;
      const labelled = shownLabelOf(inner) !== null;
      const alignment =
        inner.text.trim() === "" ? undefined : setApartOf(inner);
      if (styleId !== undefined || labelled || alignment !== undefined) {
        nested.push({
          blockId: inner.id,
          ...(styleId === undefined ? {} : { styleId }),
          ...(labelled ? { numbering: null, labelAsText: true } : {}),
          ...(alignment === undefined ? {} : { alignment }),
        });
      }
    }
  }
  return {
    kind: "source",
    blockId: table.id,
    hash: table.hash,
    ...(nested.length === 0 ? {} : { nested }),
  };
};

type ParagraphItemOptions = {
  context: Context;
  placement: Placement;
  title: DocxBlock | undefined;
  breaks: boolean;
  /** Whether the paragraph starts a page. */
  pageStart: boolean;
  /** Whether the paragraph stays on the page of the one after it. */
  keepNext: boolean;
  /** The tab stops the paragraph gets of its own. */
  tabStops: readonly number[] | undefined;
  /** Where the paragraph's lines start under the item it continues. */
  itemIndent: number | undefined;
  /** The alignment the paragraph keeps from the source. */
  alignment: TemplatePlanAlignment | undefined;
  /** The section the paragraph is the last of, when it stays a section. */
  endsSection: TemplatePlanSection | undefined;
};

/** A paragraph's item and, for a split heading, its title's bare item. */
const paragraphItems = ({
  context,
  placement,
  title,
  breaks,
  pageStart,
  keepNext,
  tabStops,
  itemIndent,
  alignment,
  endsSection,
}: ParagraphItemOptions): TemplatePlanSourceItem[] => {
  const { profile } = context;
  const { block } = placement;
  const stripped = stripOf(placement);
  const sampleJoin =
    placement.role === "annexHeading"
      ? profile.headings.annex
      : profile.headings.article;
  // A heading that is all label leaves nothing to put a break after.
  const allLabel =
    stripped.stripLabel !== undefined &&
    block.text.trim().length === stripped.stripLabel.length;
  let mergeNext: TemplatePlanSourceItem["mergeNext"] = "lineBreak";
  if (sampleJoin === "sameLine" && !breaks) {
    mergeNext = allLabel ? "none" : "space";
  }
  const numbering = numberingOf(placement);
  // A number no list prints is text in front of the paragraph.
  const hang = numbering === null ? hangOf(context, placement) : null;
  const under = itemIndent === undefined ? null : { left: itemIndent };
  const item: TemplatePlanSourceItem = {
    kind: "source",
    blockId: block.id,
    hash: block.hash,
    ...(placement.styleId === null ? {} : { styleId: placement.styleId }),
    numbering,
    ...stripped,
    ...(dropsLabelBreak(profile, placement) ? { stripLabelBreak: true } : {}),
    ...asTextOf(block, numbering),
    ...(title === undefined ? {} : { mergeNext }),
    ...(pageStart ? { pageBreakBefore: true } : {}),
    ...(endsSection === undefined ? {} : { endsSection }),
    ...(keepNext ? { keepNext: true } : {}),
    ...(hang === null ? {} : { indent: hang }),
    ...(hang === null && under !== null ? { indent: under } : {}),
    ...(tabStops === undefined ? {} : { tabStops: [...tabStops] }),
    ...(alignment === undefined ? {} : { alignment }),
  };
  return title === undefined
    ? [item]
    : [
        item,
        {
          kind: "source",
          blockId: title.id,
          hash: title.hash,
          ...asTextOf(title, null),
        },
      ];
};

type Body = {
  body: TemplatePlan["body"];
  /** Paragraphs placed, joined titles and placed cells included. */
  placedCount: number;
  contentsKept: boolean;
};

const buildBody = (context: Context, placed: Placed, breaks: boolean): Body => {
  const { topLevel, profile, items } = context;
  const { placementById, titleOf, mergedInto, omitted } = placed;
  const body: TemplatePlan["body"] = [];
  const { keepBefore, contents } = profile.regions;
  if (keepBefore.length > 0) {
    body.push({ kind: "template", templateBlockIds: keepBefore });
    items.push({
      kind: "templateBlocksKept",
      region: "keepBefore",
      blockIds: keepBefore,
    });
    for (const slot of context.headerFill?.slots ?? NO_SLOTS) {
      body.push({ kind: "slot", ...slot });
    }
    if (context.headerFill !== null) {
      const { filled, left } = context.headerFill;
      items.push({ kind: "letterheadFilled", filled, left });
    }
  }
  // A heading without a number heads what follows it: the preamble's
  // heading opens the body with its recitals.
  const opensBody = (role: HouseStyleRole): boolean =>
    role === "articleHeading" ||
    role === "recital" ||
    role === "heading" ||
    CLAUSE_ROLES.some((clause) => clause === role);
  // The table of contents stands where the template has it: after the
  // front matter, in front of the first recital or article.
  let contentsPending =
    contents.length > 0 &&
    topLevel.some(({ id }) => placementById.get(id)?.role === "articleHeading");
  let contentsKept = false;
  let placedCount = 0;
  for (const block of topLevel) {
    if (mergedInto.has(block.id) || omitted.has(block.id)) {
      continue;
    }
    if (block.kind === "table") {
      const item = tableItem(context, placed, block);
      placedCount += (item.nested ?? NO_NESTED).filter(({ blockId }) =>
        placementById.has(blockId),
      ).length;
      body.push(item);
      continue;
    }
    const placement = placementById.get(block.id);
    if (placement === undefined) {
      continue;
    }
    if (contentsPending && opensBody(placement.role)) {
      contentsPending = false;
      contentsKept = true;
      body.push({ kind: "template", templateBlockIds: contents });
      items.push({
        kind: "templateBlocksKept",
        region: "contents",
        blockIds: contents,
      });
    }
    const paragraph = paragraphItems({
      context,
      placement,
      title: titleOf.get(block.id),
      breaks,
      pageStart: placed.pageStarts.has(block.id),
      keepNext:
        placed.keptWithNext.has(block.id) || placed.closingLines.has(block.id),
      tabStops: placed.tabStops.get(block.id),
      itemIndent: placed.itemIndents.get(block.id),
      alignment: placed.alignments.get(block.id),
      endsSection: context.keptSections.ends.get(block.id),
    });
    placedCount += paragraph.length;
    body.push(...paragraph);
  }
  return { body, placedCount, contentsKept };
};

type HeaderField = "addressee" | "date" | "reference";

const NO_SLOTS: HeaderFill["slots"] = [];
const NO_LINES: readonly string[] = [];

type HeaderFill = {
  slots: { templateBlockId: string; sourceBlockIds: string[] }[];
  /** Sample lines of the addressee the letter has no line for. */
  emptied: string[];
  filled: HeaderField[];
  /** Cells of the letterhead the letter states nothing for: they keep the
   *  template's sample text. */
  left: HeaderField[];
};

/**
 * Puts the head of a letter into the letterhead the template keeps: each
 * line of the addressee into a sample line, further lines into the last
 * one, the date and the reference into their paragraphs. Sample lines of
 * the addressee the letter does not need are emptied. A cell the letter
 * states nothing for keeps the template's sample and is named in the note.
 * Null when the template keeps no letterhead or the document is no letter.
 */
const fillHeader = ({ profile, topLevel }: Context): HeaderFill | null => {
  const { header } = profile;
  if (header === undefined) {
    return null;
  }
  const head = readLetterHead(topLevel);
  const fill: HeaderFill = { slots: [], emptied: [], filled: [], left: [] };
  const cells = header.addressee;
  const lines = head?.addressee ?? NO_LINES;
  if (cells.length > 0 && lines.length > 0) {
    for (const [position, templateBlockId] of cells.entries()) {
      const last = position === cells.length - 1;
      const sourceBlockIds = last
        ? lines.slice(position)
        : lines.slice(position, position + 1);
      if (sourceBlockIds.length === 0) {
        fill.emptied.push(templateBlockId);
      } else {
        fill.slots.push({ templateBlockId, sourceBlockIds });
      }
    }
    fill.filled.push("addressee");
  } else if (cells.length > 0) {
    fill.left.push("addressee");
  }
  for (const field of ["date", "reference"] as const) {
    const templateBlockId = header[field];
    const line = head?.[field] ?? null;
    if (templateBlockId === null) {
      continue;
    }
    if (line === null) {
      fill.left.push(field);
    } else {
      fill.slots.push({ templateBlockId, sourceBlockIds: [line] });
      fill.filled.push(field);
    }
  }
  return fill;
};

/**
 * A letter's own head goes into the template's letterhead; its lines are
 * then no paragraphs of the body.
 */
const takeHeaderLines = (context: Context): void => {
  context.headerFill = fillHeader(context);
  if (context.headerFill === null) {
    return;
  }
  const slotted = new Set(
    context.headerFill.slots.flatMap(({ sourceBlockIds }) => sourceBlockIds),
  );
  context.topLevel = context.topLevel.filter(({ id }) => !slotted.has(id));
};

/** The plan option that empties sample lines of the letterhead. */
const emptiedOf = ({
  headerFill,
}: Context): Pick<TemplatePlan, "emptyTemplateBlockIds"> =>
  headerFill === null || headerFill.emptied.length === 0
    ? {}
    : { emptyTemplateBlockIds: headerFill.emptied };

const JUSTIFIED: ReadonlySet<string> = new Set(["both", "distribute"]);

/** One paragraph of the output: the blocks it is made of, its style, and
 *  whether a line break joins them. */
type OutputParagraph = {
  blockIds: string[];
  styleId: string | undefined;
  joinedByBreak: boolean;
};

/** The paragraphs a plan's body writes. A heading and the title joined to
 *  it are one paragraph, in the heading's style. */
const outputParagraphs = (body: TemplatePlan["body"]): OutputParagraph[] => {
  const paragraphs: OutputParagraph[] = [];
  let open: OutputParagraph | null = null;
  for (const item of body) {
    if (item.kind !== "source") {
      open = null;
      continue;
    }
    if (open === null) {
      open = { blockIds: [], styleId: item.styleId, joinedByBreak: false };
      paragraphs.push(open);
    }
    open.blockIds.push(item.blockId);
    for (const { blockId, styleId } of item.nested ?? NO_NESTED) {
      paragraphs.push({ blockIds: [blockId], styleId, joinedByBreak: false });
    }
    if (item.mergeNext === undefined) {
      open = null;
    } else {
      open.joinedByBreak ||= item.mergeNext === "lineBreak";
    }
  }
  return paragraphs;
};

/**
 * Whether the output has to keep the spacing of justified lines that end in
 * a manual line break, with the note that says why. A word processor
 * stretches such a line to the margin unless the document's settings say
 * otherwise, and the output's settings are the template's. The setting is
 * switched on only where that changes how the document looked: its own
 * settings had it, or a paragraph with such a break is justified by the
 * template's style and was not justified before, or got the break by being
 * joined to its heading. A manifest without these facts changes nothing.
 *
 * The setting is the whole document's. Where it is switched on for one
 * paragraph, a paragraph that was justified with such a break in the source,
 * and showed the stretched line there, loses the stretch too: one look for
 * all such lines, and the one nobody sets on purpose goes. The note counts
 * those paragraphs.
 */
const keepsLineBreakSpacing = (
  { blockById, profile, items }: Context,
  compat: DocxBlockManifest["compat"],
  body: TemplatePlan["body"],
): boolean => {
  if (compat === undefined) {
    return false;
  }
  const justifies = (styleId: string | undefined): boolean =>
    JUSTIFIED.has(
      (styleId === undefined
        ? profile.defaultAlignment
        : Object.values(profile.roles).find(
            (target) => target?.styleId === styleId,
          )?.alignment) ?? "",
    );
  let blocks = 0;
  let alreadyStretched = 0;
  for (const { blockIds, styleId, joinedByBreak } of outputParagraphs(body)) {
    const broken = blockIds
      .map((id) => blockById.get(id))
      .filter((block) => block?.text.includes("\n") === true);
    if (!justifies(styleId) || (!joinedByBreak && broken.length === 0)) {
      continue;
    }
    const wasStretched =
      !joinedByBreak &&
      broken.every((block) => JUSTIFIED.has(block?.alignment ?? ""));
    if (wasStretched) {
      alreadyStretched += 1;
    } else {
      blocks += 1;
    }
  }
  if (!compat.doNotExpandShiftReturn && blocks === 0) {
    return false;
  }
  items.push({
    kind: "lineBreakSpacingKept",
    reason: compat.doNotExpandShiftReturn ? "source" : "justifiedHere",
    blocks,
    alreadyStretched: compat.doNotExpandShiftReturn ? 0 : alreadyStretched,
  });
  return true;
};

type Marks = {
  references: TemplatePlanReference[];
  highlights: TemplatePlanHighlight[];
};

type MarkOptions = {
  context: Context;
  placed: Placed;
  levelsByList: ReadonlyMap<number, ListLevelFormat[]>;
  references: readonly DetectedReference[];
  highlightColor: string;
};

type Designator = DetectedReference["designators"][number];

type Field = Pick<TemplatePlanReference, "instruction" | "expectedText"> & {
  /** Where the field starts when it covers more than the designator. */
  start?: number;
};

/** A citation: the block's text and the designator's span in it. */
type Citation = { text: string; start: number; end: number };

const LABEL_FIELD_REASONS = {
  "case-not-reproducible": "caseNotReproducible",
  "blank-differs": "blankDiffers",
} as const;

/**
 * The field for a citation of a target whose level prints punctuated
 * words: one field over word and number that prints the whole label, or
 * why the citation stays text.
 */
const labelFieldOf = (
  citation: Citation,
  levelText: string,
  label: string | null,
  keepsSourceNumbers: boolean,
): Field | UnlinkedReason => {
  if (label === null) {
    return "punctuatedLevelWords";
  }
  const field = selectLabelField({
    ...citation,
    levelText,
    label,
    keepsSourceNumbers,
  });
  if (field.isOk()) {
    const { instruction, expectedText, start } = field.value;
    return { instruction, expectedText, start };
  }
  const { reason } = field.error;
  if (reason === "case-not-reproducible" || reason === "blank-differs") {
    return LABEL_FIELD_REASONS[reason];
  }
  return reason === "designator-mismatch"
    ? "designatorMismatch"
    : "punctuatedLevelWords";
};

/** Whether a reference's target is an annex that keeps its typed number. */
const typedAnnex = (target: Placement | undefined): boolean =>
  target?.entry?.level === "annex" &&
  target.entry.origin !== "auto" &&
  !target.numbered;

/** The field that stands for a designator citing `target`, or why none
 *  shows exactly what the reference prints. */
const fieldOf = (
  { mode }: Context,
  levelsByList: ReadonlyMap<number, ListLevelFormat[]>,
  citation: Citation,
  target: Placement,
): Field | UnlinkedReason => {
  const { level, sourceLabel, counters } = target;
  const levels =
    level === null ? undefined : levelsByList.get(level.abstractNumId);
  const own = levels?.find(({ ilvl }) => ilvl === level?.ilvl);
  if (levels === undefined || own === undefined || sourceLabel === null) {
    return "targetNotNumbered";
  }
  // Under the house scheme the field shows the template's number, which
  // may differ from the designator the sentence was written with.
  const field = selectReferenceField({
    designatorText: citation.text.slice(citation.start, citation.end),
    levelText: own.lvlText,
    numbering:
      mode === "keepSource"
        ? { mode, sourceLabel }
        : { mode, levels, counters },
  });
  if (field.isOk()) {
    return {
      instruction: field.value.instruction,
      expectedText: field.value.expectedText,
    };
  }
  if (field.error.reason !== "punctuated-words") {
    return "designatorMismatch";
  }
  // No field shows the bare number of such a level; one over the
  // citation's word and number shows the label the output prints.
  return labelFieldOf(
    citation,
    own.lvlText,
    mode === "keepSource" ? sourceLabel : plannedLabelOf(target, levelsByList),
    mode === "keepSource",
  );
};

/** The block a designator cites, or why it names none. */
const targetOf = (
  { decisions }: Context,
  reference: DetectedReference,
  designatorIndex: number,
  { resolution }: Designator,
): { targetBlockId: string } | { reason: UnlinkedReason } | null => {
  switch (resolution.status) {
    case "resolved":
      return { targetBlockId: resolution.targetBlockId };
    case "ambiguous": {
      const decided = decisions.get(
        targetItemId(reference.id, designatorIndex),
      );
      return decided === undefined
        ? { reason: "ambiguous" }
        : { targetBlockId: decided };
    }
    case "unresolved":
      return { reason: "unresolved" };
    case "skipped":
      return null;
    default: {
      resolution satisfies never;
      return panic("Unhandled resolution");
    }
  }
};

/** References as fields where a field shows what the source prints, and
 *  highlights where an internal reference has no target. */
const markReferences = ({
  context,
  placed,
  levelsByList,
  references,
  highlightColor,
}: MarkOptions): Marks => {
  const { blocks, blockById, tableOf, index, exclusions, decisions, items } =
    context;
  const { placementById, mergedInto } = placed;
  const marks: Marks = { references: [], highlights: [] };
  const takenSpans = new Map<string, { start: number; end: number }[]>();
  // A cell paragraph is placed with its table, with or without a reading.
  const isPlaced = (blockId: string): boolean =>
    placementById.has(blockId) ||
    mergedInto.has(blockId) ||
    tableOf.has(blockId);
  const strippedLength = (blockId: string): number => {
    const placement = placementById.get(blockId);
    return placement?.numbered === true && placement.entry?.origin === "manual"
      ? placement.entry.manualLength
      : 0;
  };
  const claim = (blockId: string, start: number, end: number): boolean => {
    const taken = takenSpans.get(blockId);
    if (
      !isPlaced(blockId) ||
      exclusions.marks.has(blockId) ||
      start < strippedLength(blockId) ||
      taken?.some((span) => start < span.end && end > span.start) === true
    ) {
      return false;
    }
    if (taken === undefined) {
      takenSpans.set(blockId, [{ start, end }]);
    } else {
      taken.push({ start, end });
    }
    return true;
  };
  // "No such provision" is only as sure as the reading of the document's
  // numbering. Where many automatic labels could not be read, a reference
  // without a target more likely names one of those, and marking it would
  // fill the document with false alarms: it is reported, not highlighted.
  // An annex is headed in words, not by a list, so a missing annex is
  // marked either way.
  const labelled = blocks.filter(
    (block) =>
      block.kind === "paragraph" &&
      printedLabel(block) !== null &&
      !isBulleted(block),
  );
  const unread = labelled.filter(({ id }) => !index.entryByBlockId.has(id));
  const numberingRead =
    unread.length <= labelled.length * UNREAD_LABELS_SHARE_MAX;
  /** Whether the output prints another label for the block than the
   *  source: only the house scheme does that. */
  const isRenumbered = (targetBlockId: string | null): boolean => {
    const target =
      targetBlockId === null ? undefined : placementById.get(targetBlockId);
    const planned =
      target === undefined ? null : plannedLabelOf(target, levelsByList);
    return (
      context.mode === "houseScheme" &&
      planned !== null &&
      planned.trim() !== (target?.sourceLabel ?? "").trim()
    );
  };
  const unlinked = (
    { blockId }: DetectedReference,
    { start, end, level }: Designator,
    reason: UnlinkedReason,
    targetBlockId: string | null = null,
  ) => {
    // A citation left as text names its target by the old number. Where
    // the target got a new one, the place is marked for a person to fix.
    const targetRenumbered = isRenumbered(targetBlockId);
    const unresolved =
      (numberingRead || level === "annex") &&
      (reason === "unresolved" || reason === "ambiguous");
    const highlighted =
      (unresolved || targetRenumbered) && claim(blockId, start, end);
    if (highlighted) {
      marks.highlights.push({ blockId, start, end, color: highlightColor });
    }
    items.push({
      kind: "referenceUnlinked",
      blockId,
      start,
      end,
      reason,
      highlighted,
      ...(targetRenumbered ? { targetRenumbered } : {}),
    });
  };
  /** Why the designator cannot be a field to `targetBlockId`, or the field. */
  const link = (
    reference: DetectedReference,
    designator: Designator,
    targetBlockId: string,
  ): UnlinkedReason | TemplatePlanReference => {
    const { start, end } = designator;
    const target = placementById.get(targetBlockId);
    if (
      target === undefined ||
      !target.numbered ||
      exclusions.targets.has(targetBlockId)
    ) {
      return typedAnnex(target) ? "annexTyped" : "targetNotNumbered";
    }
    const paragraphOf = (blockId: string): string =>
      mergedInto.get(blockId) ?? blockId;
    if (paragraphOf(reference.blockId) === paragraphOf(targetBlockId)) {
      return "sameParagraph";
    }
    const text = blockById.get(reference.blockId)?.text;
    if (text === undefined) {
      return "notPlaceable";
    }
    const field = fieldOf(context, levelsByList, { text, start, end }, target);
    if (typeof field === "string") {
      return field;
    }
    const { instruction, expectedText } = field;
    const from = field.start ?? start;
    return claim(reference.blockId, from, end)
      ? {
          blockId: reference.blockId,
          start: from,
          end,
          targetBlockId,
          instruction,
          expectedText,
        }
      : "notPlaceable";
  };
  for (const reference of references) {
    const scope =
      reference.scope === "unknown"
        ? (decisions.get(scopeItemId(reference.id)) ?? "unknown")
        : reference.scope;
    if (scope === "external") {
      continue;
    }
    for (const [position, designator] of reference.designators.entries()) {
      if (scope === "unknown") {
        unlinked(reference, designator, "undecidedScope");
        continue;
      }
      const target = targetOf(context, reference, position, designator);
      if (target === null) {
        continue;
      }
      const linked =
        "reason" in target
          ? target.reason
          : link(reference, designator, target.targetBlockId);
      if (typeof linked === "string") {
        unlinked(
          reference,
          designator,
          linked,
          "reason" in target ? null : target.targetBlockId,
        );
      } else {
        marks.references.push(linked);
      }
    }
  }
  return marks;
};

/** Labels that stay text or are lost, suspected references and roles the
 *  template has no style for. */
const noteReadings = (
  { items, stylelessRoles }: Context,
  { placements }: Placed,
  references: readonly DetectedReference[],
  suspicions: readonly ReferenceSuspicion[],
): void => {
  for (const { entry, numbered, keptReason, block } of placements) {
    // An annex heading is typed by the template's own convention.
    const byConvention =
      keptReason === "noListLevel" && entry?.level === "annex";
    // An automatic label that no list prints is reported with the plan
    // item that writes it as text.
    if (
      numbered ||
      keptReason === null ||
      byConvention ||
      entry?.origin !== "manual"
    ) {
      continue;
    }
    items.push({
      kind: "labelKeptAsText",
      blockId: block.id,
      reason: keptReason,
    });
  }
  const referenceById = new Map(
    references.map((reference) => [reference.id, reference]),
  );
  for (const suspicion of suspicions) {
    const reference = referenceById.get(suspicion.referenceId);
    const designator = reference?.designators[suspicion.designatorIndex];
    if (reference === undefined || designator === undefined) {
      continue;
    }
    items.push({
      kind: "referenceSuspected",
      blockId: reference.blockId,
      start: designator.start,
      end: designator.end,
      citedBlockId: suspicion.citedBlockId,
      suggestedBlockId: suspicion.suggestedBlockId,
      confidence: suspicion.confidence,
    });
  }
  for (const [role, count] of stylelessRoles) {
    items.push({ kind: "roleWithoutStyle", role, blocks: count });
  }
  const asText = placements.filter(
    ({ role, block, entry }) =>
      role === "articleHeading" && runsOn(block, entry),
  ).length;
  if (asText > 0) {
    items.push({ kind: "articlesSetAsText", blocks: asText });
  }
};

/** What a plan asks for one source paragraph's label. */
type LabelRequest = {
  numbered: boolean;
  stripLabel: string | null;
  labelAsText: boolean;
};

const NO_LABEL_REQUEST: LabelRequest = {
  numbered: false,
  stripLabel: null,
  labelAsText: false,
};

const labelRequestOf = ({
  numbering,
  stripLabel,
  labelAsText,
}: TemplatePlanNestedParagraph): LabelRequest => ({
  numbered: typeof numbering === "object" && numbering !== null,
  stripLabel: stripLabel ?? null,
  labelAsText: labelAsText === true,
});

/** Every source paragraph the body places, with what the plan asks for its
 *  label. Read off the finished body, not off the steps that built it. */
const labelRequests = (
  { blockById }: Context,
  body: TemplatePlan["body"],
): Map<string, LabelRequest> => {
  const requests = new Map<string, LabelRequest>();
  for (const item of body) {
    if (item.kind === "slot") {
      for (const id of item.sourceBlockIds) {
        requests.set(id, NO_LABEL_REQUEST);
      }
    }
    if (item.kind !== "source") {
      continue;
    }
    requests.set(item.blockId, labelRequestOf(item));
    const table = blockById.get(item.blockId);
    if (table?.kind !== "table") {
      continue;
    }
    for (const { id } of insideOf(table, blockById)) {
      requests.set(id, NO_LABEL_REQUEST);
    }
    for (const nested of item.nested ?? NO_NESTED) {
      requests.set(nested.blockId, labelRequestOf(nested));
    }
  }
  return requests;
};

type LabelCheckOptions = {
  context: Context;
  placed: Placed;
  levelsByList: ReadonlyMap<number, readonly ListLevelFormat[]>;
  body: TemplatePlan["body"];
};

/**
 * The placed paragraphs that would not show the label the source shows.
 *
 * A label the source shows is automatic or typed and stripped. The output
 * shows it when the paragraph's list prints the same label, or when it is
 * written as text. The house scheme renumbers on purpose, so there a list
 * may print another label, but never none.
 */
const checkLabels = ({
  context,
  placed,
  levelsByList,
  body,
}: LabelCheckOptions): PlannedLabelIssue[] => {
  const issues: PlannedLabelIssue[] = [];
  for (const [blockId, request] of labelRequests(context, body)) {
    const block = context.blockById.get(blockId);
    if (block?.kind !== "paragraph") {
      continue;
    }
    const shown = shownLabelOf(block);
    const source = shown ?? request.stripLabel?.trim() ?? null;
    if (source === null) {
      continue;
    }
    const placement = placed.placementById.get(blockId);
    const planned =
      request.numbered && placement !== undefined
        ? plannedLabelOf(placement, levelsByList)
        : null;
    if (!request.numbered) {
      if (shown === null || !request.labelAsText) {
        issues.push({ blockId, kind: "lost" });
      }
    } else if (
      request.labelAsText ||
      (context.mode === "keepSource" &&
        planned?.trim() !== closeNumberParts(source))
    ) {
      issues.push({ blockId, kind: "differs" });
    }
  }
  return issues;
};

/** The paragraphs whose automatic label the plan writes as text. */
const noteConvertedLabels = (
  { items }: Context,
  { placementById }: Placed,
  requests: ReadonlyMap<string, LabelRequest>,
): number => {
  let converted = 0;
  for (const [blockId, { labelAsText }] of requests) {
    if (!labelAsText) {
      continue;
    }
    converted += 1;
    const placement = placementById.get(blockId);
    items.push({
      kind: "labelConvertedToText",
      blockId,
      reason:
        placement?.keptReason ??
        (placement?.entry === null ? "unreadable" : "noListLevel"),
    });
  }
  return converted;
};

/**
 * Builds the plan for one document and one template profile, and the note
 * that says what was linked, what was left as text and why. Pure: the same
 * readings give the same plan.
 */
/**
 * Where the template is in another language than the document: the label
 * words of the template's own scheme go into the document's language, and
 * the note says what language each is in.
 */
const noteLanguages = (
  { items, mode }: Context,
  languages: PlanLanguages | undefined,
  numbering: Pick<
    Parameters<typeof levelsInLanguage>[0],
    "patches" | "levelsByList"
  >,
): void => {
  if (
    languages === undefined ||
    languages.template.includes(languages.document)
  ) {
    return;
  }
  items.push({
    kind: "templateLanguageDiffers",
    document: languages.document,
    template: [...languages.template],
    labelLevels:
      mode === "houseScheme"
        ? levelsInLanguage({ languages, ...numbering })
        : 0,
  });
};

/** Says how many paragraphs were kept with the next and how many hang. */
const noteParagraphOptions = (
  { items }: Context,
  { keptWithNext, closingLines, tabStops, itemIndents }: Placed,
  body: TemplatePlan["body"],
): void => {
  if (itemIndents.size > 0) {
    items.push({ kind: "continuationsIndented", blocks: itemIndents.size });
  }
  if (keptWithNext.size > 0) {
    items.push({ kind: "linesKeptWithNext", blocks: keptWithNext.size });
  }
  if (closingLines.size > 0) {
    items.push({ kind: "closingKeptTogether", blocks: closingLines.size });
  }
  const hung = body.filter(
    (item) => item.kind === "source" && item.indent?.hanging !== undefined,
  ).length;
  if (hung > 0) {
    items.push({ kind: "textLabelsHung", blocks: hung });
  }
  if (tabStops.size > 0) {
    items.push({ kind: "partyLinesAligned", blocks: tabStops.size });
  }
  let aligned = 0;
  for (const item of body) {
    if (item.kind === "source") {
      aligned +=
        (item.alignment === undefined ? 0 : 1) +
        (item.nested ?? NO_NESTED).filter(
          (nested) => nested.alignment !== undefined,
        ).length;
    }
  }
  if (aligned > 0) {
    items.push({ kind: "alignmentsKept", blocks: aligned });
  }
  const closed = body.filter(
    (item) =>
      item.kind === "source" &&
      item.stripLabel !== undefined &&
      item.stripLabel !== closeNumberParts(item.stripLabel),
  ).length;
  if (closed > 0) {
    items.push({ kind: "numberPartsClosed", blocks: closed });
  }
  const joined = body.filter(
    (item) => item.kind === "source" && item.stripLabelBreak === true,
  ).length;
  if (joined > 0) {
    items.push({ kind: "headingBreaksDropped", blocks: joined });
  }
};

export const buildTemplatePlan = ({
  manifest,
  profile,
  references,
  roles,
  mode,
  index = buildLabelIndex(manifest),
  decisions = new Map<string, string>(),
  suspicions = [],
  exclusions = NO_EXCLUSIONS,
  sourceHighlightColors,
  trackedChangesStated = false,
  languages,
}: BuildOptions): BuiltPlan => {
  const { blocks } = manifest;
  const tableOf = new Map<string, string>();
  for (const block of blocks) {
    if (block.cells !== undefined) {
      for (const id of block.cells.flatMap(({ blockIds }) => blockIds)) {
        tableOf.set(id, block.id);
      }
    }
  }
  const context: Context = {
    blocks,
    blockById: new Map(blocks.map((block) => [block.id, block])),
    tableOf,
    topLevel: blocks.filter(({ id }) => !tableOf.has(id)),
    sections: manifest.sections ?? NO_SECTIONS,
    keptSections: NO_KEPT_SECTIONS,
    index,
    profile,
    mode,
    exclusions,
    decisions,
    proposalById: new Map(roles.map((role) => [role.blockId, role])),
    outline: {
      article: profile.roles.articleHeading?.numbering ?? null,
      clauses: CLAUSE_ROLES.map(
        (role) => profile.roles[role]?.numbering ?? null,
      ),
    },
    stylelessRoles: new Map(),
    items: [],
    headerFill: null,
  };
  takeHeaderLines(context);

  context.keptSections = sectionsToKeep(context);
  const placed = placeParagraphs(context);
  const { patches, levelsByList } = numberPlacements({
    placements: placed.placements,
    mode,
    spareLevels: profile.spareLevels,
    markLevels: profile.markLevels,
  });
  noteLanguages(context, languages, { patches, levelsByList });
  const breaks = breaksHeadings(profile, placed);
  settleBrokenHeadings(context, placed, patches, breaks);
  const { body, placedCount, contentsKept } = buildBody(
    context,
    placed,
    breaks,
  );
  // With every colour taken the first still marks the place.
  const highlightColor =
    UNRESOLVED_REFERENCE_HIGHLIGHTS.find(
      (color) => !sourceHighlightColors.includes(color),
    ) ?? UNRESOLVED_REFERENCE_HIGHLIGHTS[0];
  const marks = markReferences({
    context,
    placed,
    levelsByList,
    references,
    highlightColor,
  });
  const labelsConvertedToText = noteConvertedLabels(
    context,
    placed,
    labelRequests(context, body),
  );
  noteReadings(context, placed, references, suspicions);
  if (manifest.trackedChangesResolved !== undefined) {
    context.items.unshift({
      kind: "trackedChangesResolved",
      stated: trackedChangesStated,
      ...manifest.trackedChangesResolved,
    });
  }

  const health = profile.health ?? NO_HEALTH;
  const drawn = {
    levels: health.filter(({ kind }) => kind === "numberDrawnAsPicture").length,
    styles: health.filter(({ kind }) => kind === "textDrawnAsPicture").length,
  };
  if (drawn.levels > 0 || drawn.styles > 0) {
    context.items.push({ kind: "invisibleEffectsRemoved", ...drawn });
  }
  for (const finding of health) {
    const evened =
      finding.kind === "levelSetApart" && profile.levelLooks !== "asTemplate"
        ? placed.placements.filter(
            ({ role, styleId }) =>
              role === finding.role && styleId === finding.insteadStyleId,
          ).length
        : 0;
    if (finding.kind === "levelSetApart" && evened > 0) {
      context.items.push({
        kind: "levelStyleEvened",
        role: finding.role,
        styleId: finding.styleId,
        insteadStyleId: finding.insteadStyleId,
        blocks: evened,
      });
    }
  }
  noteParagraphOptions(context, placed, body);
  const lineBreakSpacing = keepsLineBreakSpacing(
    context,
    manifest.compat,
    body,
  );

  const plan: TemplatePlan = {
    version: 1,
    sourceSha256: manifest.sha256,
    templateSha256: profile.templateSha256,
    // A manifest read in one view of tracked changes gives a plan for it.
    ...(manifest.trackedChangesResolved === undefined
      ? {}
      : { trackedChanges: manifest.trackedChangesResolved.view }),
    body,
    omit: [...placed.omitted].map(([blockId, reason]) => ({ blockId, reason })),
    ...emptiedOf(context),
    ...(patches.length === 0 ? {} : { numberingPatches: patches }),
    ...(marks.references.length === 0 ? {} : { references: marks.references }),
    ...(marks.highlights.length === 0 ? {} : { highlights: marks.highlights }),
    fields: {
      freezeKinds: profile.fields.freezeKinds,
      // Word fills a field's result when it opens the file; without that a
      // kept table of contents would show the template's sample entries.
      updateOnOpen: marks.references.length > 0 || contentsKept,
    },
    ...(lineBreakSpacing ? { compat: { doNotExpandShiftReturn: true } } : {}),
    ...(context.keptSections.last === undefined
      ? {}
      : { lastSection: context.keptSections.last }),
  };
  return {
    plan,
    note: {
      mode,
      counts: {
        placed: placedCount,
        omitted: placed.omitted.size,
        numbered: placed.placements.filter(({ numbered }) => numbered).length,
        labelsConvertedToText,
        pageStarts: placed.pageStarts.size,
        sectionsKept:
          context.keptSections.ends.size +
          (context.keptSections.last === undefined ? 0 : 1),
        numberingPatches: patches.length,
        referencesLinked: marks.references.length,
        referencesUnlinked: context.items.filter(
          ({ kind }) => kind === "referenceUnlinked",
        ).length,
        referencesHighlighted: marks.highlights.length,
      },
      items: context.items,
    },
    labelsNotKept: checkLabels({ context, placed, levelsByList, body }),
  };
};
