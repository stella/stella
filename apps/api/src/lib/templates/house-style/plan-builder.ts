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
import { isStrippableLabel } from "@/api/lib/templates/house-style/folio-contract";
import type {
  DocxBlock,
  DocxBlockManifest,
  DocxSection,
  TemplatePlan,
  TemplatePlanHighlight,
  TemplatePlanNestedParagraph,
  TemplatePlanNumbering,
  TemplatePlanNumberingPatch,
  TemplatePlanReference,
  TemplatePlanSection,
  TemplatePlanSourceItem,
} from "@/api/lib/templates/house-style/folio-contract";
import { buildLabelIndex } from "@/api/lib/templates/house-style/label-index";
import type { LabelIndex } from "@/api/lib/templates/house-style/label-index";
import {
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
} from "@/api/lib/templates/house-style/plan-numbering";
import type { DetectedReference } from "@/api/lib/templates/house-style/reference-detector";
import {
  selectReferenceField,
  showsBareNumber,
} from "@/api/lib/templates/house-style/reference-fields";
import type { ReferenceSuspicion } from "@/api/lib/templates/house-style/reference-suspicions";
import {
  HOUSE_STYLE_ROLES,
  isBlankParagraph,
  isBulletMark,
} from "@/api/lib/templates/house-style/role-proposer";
import type {
  HouseStyleRole,
  RoleProposal,
} from "@/api/lib/templates/house-style/role-proposer";
import type {
  ProfileRoleTarget,
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
  /** The field would show another text than the source prints. */
  | "designatorMismatch"
  /** The target's level prints words with punctuation (`Čl. 3`,
   *  `Příloha č. 2`); a field drops the words and keeps the punctuation,
   *  so it would show `.2`. */
  | "punctuatedLevelWords"
  /** The reference stands in the paragraph it names. */
  | "sameParagraph"
  /** The span cannot carry a field: it lies in a stripped label or in a
   *  block the plan does not place, or the engine refused it. */
  | "notPlaceable";

type FormattingNoteItem =
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
  /** The source starts a page in front of this block and the output does
   *  not: a table cannot be told to start one. */
  | { kind: "pageStartNotKept"; blockId: string; reason: "table" }
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
   *  in the source, or got their break by being joined (`justifiedHere`). */
  | {
      kind: "lineBreakSpacingKept";
      reason: "source" | "justifiedHere";
      blocks: number;
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

const styleTarget = (
  { profile, stylelessRoles }: Context,
  role: HouseStyleRole,
): ProfileRoleTarget | null => {
  const own = profile.roles[role];
  if (own !== null) {
    return own;
  }
  stylelessRoles.set(role, (stylelessRoles.get(role) ?? 0) + 1);
  for (const fallback of STYLE_FALLBACK[role]) {
    const target = profile.roles[fallback];
    if (target !== null) {
      return target;
    }
  }
  return null;
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
  const target =
    entry === null && ownLevel !== null && NUMBERED_ONLY.has(role)
      ? styleTarget(context, "body")
      : styleTarget(context, role);
  const mark = (block.label ?? "").trim();
  const bulleted = entry === null && isBulletMark(mark);
  const placement: Placement = {
    block,
    role,
    entry,
    styleId: target?.styleId ?? null,
    level: entry === null && !bulleted ? null : ownLevel,
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
      entry !== null || block.label !== null ? "excluded" : null;
    return placement;
  }
  if (entry === null) {
    // A bulleted paragraph keeps its mark: on the template's bullet level,
    // or on a spare one.
    if (bulleted) {
      placement.sourceLabel = mark;
      placement.pattern = { numFmt: "bullet", lvlText: mark };
      placement.numbered = true;
    }
    return placement;
  }
  const lead = block.text.length - block.text.trimStart().length;
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
const tableSeparators = (context: Context): Set<string> => {
  const { topLevel, index } = context;
  const separators = new Set<string>();
  /** Whether only blank paragraphs came since the last table. */
  let afterTable = false;
  let firstBlank: string | null = null;
  const keep = () => {
    if (afterTable && firstBlank !== null) {
      separators.add(firstBlank);
    }
  };
  for (const block of topLevel) {
    if (block.kind === "table") {
      keep();
      afterTable = true;
      firstBlank = null;
      continue;
    }
    if (!afterTable || index.contentsBlockIds.has(block.id)) {
      continue;
    }
    if (roleOf(context, block) === null && isBlankParagraph(block)) {
      firstBlank ??= block.id;
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
): Set<string> => {
  const starts = new Set<string>();
  /** A page start waits for the next block that is placed. */
  let pending = false;
  /** Nothing starts a page in front of the document's first block. */
  let placedAny = false;
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
    } else if (holders.has(block.id)) {
      // The page starts with this paragraph, also where the section it
      // closes ends in front of the table. With a break of its own among
      // its runs it needs no telling.
      if ((block.pageBreaks ?? 0) === 0) {
        starts.add(block.id);
      }
      pending = false;
      placedAny = true;
      continue;
    } else if (placed.omitted.has(block.id)) {
      pending ||= breaksPage(block);
    } else if (!placed.mergedInto.has(block.id)) {
      if ((pending || block.pageBreakBefore === true) && placedAny) {
        starts.add(block.id);
      }
      pending = false;
      placedAny = true;
    }
    pending ||= endsPage(context, block);
  }
  return starts;
};

/** A placement for every paragraph that gets one, in document order. */
const placeParagraphs = (context: Context): Placed => {
  const { topLevel, blockById, index, exclusions, proposalById } = context;
  const pageHolders = pageHoldersBeforeTables(context);
  // A blank paragraph that ends a section which stays one carries it.
  const kept = new Set([
    ...tableSeparators(context),
    ...pageHolders,
    ...context.keptSections.ends.keys(),
  ]);
  const placed: Placed = {
    placements: [],
    placementById: new Map(),
    titleOf: new Map(),
    mergedInto: new Map(),
    omitted: new Map(),
    pageStarts: new Set(),
  };
  /** The paragraph placed last at the top level; a table ends the run. */
  let lastPlaced: string | null = null;
  for (const block of topLevel) {
    if (block.kind === "table") {
      lastPlaced = null;
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
    if (
      head !== null &&
      lastPlaced === head &&
      !placed.titleOf.has(head) &&
      !exclusions.merges.has(head)
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
    placed.placements.push(placement);
    lastPlaced = block.id;
  }
  for (const placement of placed.placements) {
    placed.placementById.set(placement.block.id, placement);
  }
  placed.pageStarts = pageStartsOf(context, placed, pageHolders);
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

/**
 * Whether the document breaks its headings after the number. A heading
 * typed in one paragraph with a line break after its number cannot lose
 * that break; where the document writes its headings so, a heading split
 * over two paragraphs joins the same way, and otherwise it joins as the
 * template's sample heading reads.
 */
const breaksHeadings = ({ placements, titleOf }: Placed): boolean => {
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
  const onLevel = placements.filter(
    (placement) => placement.numbered && placement.level === level,
  );
  const { left, hanging } = level.indent;
  const offCentre =
    heading.alignment === "center" &&
    ((left !== null && left !== 0) || (hanging !== null && hanging !== 0)) &&
    onLevel.some(
      ({ block }) =>
        block.text.includes("\n") || (breaks && titleOf.has(block.id)),
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

const tableItem = (
  { blockById }: Context,
  { placementById }: Placed,
  table: DocxBlock,
): TemplatePlanSourceItem => {
  const nested: TemplatePlanNestedParagraph[] = [];
  for (const inner of insideOf(table, blockById)) {
    const placement = placementById.get(inner.id);
    if (placement !== undefined) {
      const numbering = numberingOf(placement);
      nested.push({
        blockId: inner.id,
        ...(placement.styleId === null ? {} : { styleId: placement.styleId }),
        numbering,
        ...stripOf(placement),
        ...asTextOf(inner, numbering),
      });
    } else if (inner.kind === "paragraph" && shownLabelOf(inner) !== null) {
      // A cell paragraph placed with its table joins no list of the
      // template; the number it shows goes with it as text.
      nested.push({ blockId: inner.id, numbering: null, labelAsText: true });
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
  /** The section the paragraph is the last of, when it stays a section. */
  endsSection: TemplatePlanSection | undefined;
};

/** A paragraph's item and, for a split heading, its title's bare item. */
const paragraphItems = ({
  context: { profile },
  placement,
  title,
  breaks,
  pageStart,
  endsSection,
}: ParagraphItemOptions): TemplatePlanSourceItem[] => {
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
  const item: TemplatePlanSourceItem = {
    kind: "source",
    blockId: block.id,
    hash: block.hash,
    ...(placement.styleId === null ? {} : { styleId: placement.styleId }),
    numbering,
    ...stripped,
    ...asTextOf(block, numbering),
    ...(title === undefined ? {} : { mergeNext }),
    ...(pageStart ? { pageBreakBefore: true } : {}),
    ...(endsSection === undefined ? {} : { endsSection }),
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
  }
  const opensBody = (role: HouseStyleRole): boolean =>
    role === "articleHeading" ||
    role === "recital" ||
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
      endsSection: context.keptSections.ends.get(block.id),
    });
    placedCount += paragraph.length;
    body.push(...paragraph);
  }
  return { body, placedCount, contentsKept };
};

const JUSTIFIED: ReadonlySet<string> = new Set(["both", "distribute"]);

/**
 * Whether the output has to keep the spacing of justified lines that end in
 * a manual line break, with the note that says why. A word processor
 * stretches such a line to the margin unless the document's settings say
 * otherwise, and the output's settings are the template's. The setting is
 * switched on only where that changes how the document looked: its own
 * settings had it, or a paragraph with such a break is justified by the
 * template's style and was not justified before, or got the break by being
 * joined to its heading. A manifest without these facts changes nothing.
 */
const keepsLineBreakSpacing = (
  { blockById, profile, items }: Context,
  compat: DocxBlockManifest["compat"],
  body: TemplatePlan["body"],
): boolean => {
  if (compat === undefined) {
    return false;
  }
  const alignmentOf = (styleId: string | undefined): string | null =>
    styleId === undefined
      ? (profile.defaultAlignment ?? null)
      : (Object.values(profile.roles).find(
          (target) => target?.styleId === styleId,
        )?.alignment ?? null);
  const stretched = (
    blockId: string,
    styleId: string | undefined,
    joinedByBreak: boolean,
  ): boolean => {
    const block = blockById.get(blockId);
    return (
      block !== undefined &&
      JUSTIFIED.has(alignmentOf(styleId) ?? "") &&
      (joinedByBreak ||
        (block.text.includes("\n") && !JUSTIFIED.has(block.alignment ?? "")))
    );
  };
  const blocks = body
    .flatMap((item) => (item.kind === "source" ? [item] : []))
    .flatMap(({ blockId, styleId, mergeNext, nested = NO_NESTED }) => [
      stretched(blockId, styleId, mergeNext === "lineBreak"),
      ...nested.map((inner) => stretched(inner.blockId, inner.styleId, false)),
    ])
    .filter(Boolean).length;
  if (!compat.doNotExpandShiftReturn && blocks === 0) {
    return false;
  }
  items.push({
    kind: "lineBreakSpacingKept",
    reason: compat.doNotExpandShiftReturn ? "source" : "justifiedHere",
    blocks,
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

type Field = Pick<TemplatePlanReference, "instruction" | "expectedText">;

/** The field that stands for a designator citing `target`, or why none
 *  shows exactly what the reference prints. */
const fieldOf = (
  { mode }: Context,
  levelsByList: ReadonlyMap<number, ListLevelFormat[]>,
  designatorText: string,
  { level, sourceLabel, counters }: Placement,
): Field | UnlinkedReason => {
  const levels =
    level === null ? undefined : levelsByList.get(level.abstractNumId);
  const own = levels?.find(({ ilvl }) => ilvl === level?.ilvl);
  if (levels === undefined || own === undefined || sourceLabel === null) {
    return "targetNotNumbered";
  }
  // Under the house scheme the field shows the template's number, which
  // may differ from the designator the sentence was written with.
  const field = selectReferenceField({
    designatorText,
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
  return field.error.reason === "punctuated-words"
    ? "punctuatedLevelWords"
    : "designatorMismatch";
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
    ({ kind, label }) =>
      kind === "paragraph" && label !== null && !isBulletMark(label),
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
      return "targetNotNumbered";
    }
    const paragraphOf = (blockId: string): string =>
      mergedInto.get(blockId) ?? blockId;
    if (paragraphOf(reference.blockId) === paragraphOf(targetBlockId)) {
      return "sameParagraph";
    }
    const text = blockById.get(reference.blockId)?.text.slice(start, end);
    if (text === undefined) {
      return "notPlaceable";
    }
    const field = fieldOf(context, levelsByList, text, target);
    if (typeof field === "string") {
      return field;
    }
    return claim(reference.blockId, start, end)
      ? { blockId: reference.blockId, start, end, targetBlockId, ...field }
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
      (context.mode === "keepSource" && planned?.trim() !== source)
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
  };

  context.keptSections = sectionsToKeep(context);
  const placed = placeParagraphs(context);
  const { patches, levelsByList } = numberPlacements({
    placements: placed.placements,
    mode,
    spareLevels: profile.spareLevels,
  });
  const breaks = breaksHeadings(placed);
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

  const lineBreakSpacing = keepsLineBreakSpacing(
    context,
    manifest.compat,
    body,
  );

  const plan: TemplatePlan = {
    version: 1,
    sourceSha256: manifest.sha256,
    templateSha256: profile.templateSha256,
    body,
    omit: [...placed.omitted].map(([blockId, reason]) => ({ blockId, reason })),
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
