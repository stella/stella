// The block-manifest and template-plan contract the steps in this directory
// read and write: the part of the DOCX engine's shapes they use, with a
// table's paragraphs listed flat. `folio-engine.ts` implements it over the
// engine package and is where the compiler holds the two against each
// other; nothing else in this directory imports the package.

import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { declareFingerprintFields } from "@stll/errors";

/** One main-story block. Offsets used across this directory are UTF-16 code
 *  units into `text`, the unit the plan's reference spans are written in. */
export type DocxBlock = {
  /** Stable within one manifest: `p<index>` for paragraphs, `t<index>` for
   *  tables. A table's cell paragraphs are blocks of their own. */
  id: string;
  index: number;
  kind: "paragraph" | "table";
  /** Visible text: `\t` for a tab, `\n` for a line break, no-break spaces
   *  kept, field results included, the footnote marker as U+FFFC. */
  text: string;
  /** Rendered automatic list label (`1.`, `a)`, `(ii)`, `Čl. 3`); null when
   *  the paragraph is not auto-numbered. Never part of `text`. */
  label: string | null;
  /** `bullet`: the level prints a bullet, so the label is a mark,
   *  whatever character stands for it, and no designator. `bulletFont`:
   *  the text face the mark is a character of; in another face it is
   *  another shape. Both absent from a manifest read before they were
   *  reported. */
  numbering: {
    numId: number;
    ilvl: number;
    abstractNumId: number;
    bullet?: true;
    bulletFont?: string;
  } | null;
  styleId: string | null;
  styleName: string | null;
  outlineLevel: number | null;
  sectionIndex: number;
  /** Short hash of text and label; a plan pins a block with it. */
  hash: string;
  /** Pictures, drawings and embedded objects anchored in the block; a block
   *  that holds one is not empty even without text. */
  inlineObjects?: number;
  /** Page breaks among the paragraph's runs; a paragraph without text can
   *  hold one. */
  pageBreaks?: number;
  /** Offsets in `text` at which the paragraph holds a field that numbers
   *  itself: the number it prints is in no text. Absent without one. */
  selfNumbers?: number[];
  /** The tracked changes the paragraph holds, in a manifest read with the
   *  changes kept: where each sits in `text`. Absent without one. */
  revisions?: DocxBlockRevision[];
  /** The paragraph's cross-reference fields, in the order they stand.
   *  Absent without one, and from an engine that does not report them. */
  crossReferences?: DocxBlockCrossReference[];
  /** The paragraph starts on a new page by its own formatting or its
   *  style's. */
  pageBreakBefore?: true;
  /** The paragraph is the last of its section: the block after it opens
   *  `sections[sectionIndex + 1]`. */
  endsSection?: true;
  /** The paragraph alignment in effect (`w:jc`): the paragraph's own, else
   *  its style's. Absent when neither states one. */
  alignment?: string;
  /** The space the paragraph states for itself in front of it and behind
   *  it, in twentieths of a point; a side it does not state is left out.
   *  Absent when it states neither, and from an engine that does not
   *  report it. What its style gives is not here. */
  spacing?: TemplatePlanSpacing;
  /** The space in effect in front of the paragraph and behind it, in
   *  twentieths of a point: each side its own, else its style's, else the
   *  document defaults', else none. A side set to auto spacing or counted
   *  in lines is left out. The line spacing resolved the same way, single
   *  where nothing states one. Absent from an engine that does not report
   *  it. */
  spacingInEffect?: {
    before?: number;
    after?: number;
    line?: number;
    lineRule?: TemplatePlanLineRule;
  };
  /** The indent in effect, in twentieths of a point: where the
   *  paragraph's lines start, and what its first line adds to that
   *  (negative for a hanging indent). Absent when nothing states one, and
   *  from a manifest read before it was reported. */
  indent?: { left: number; firstLine: number };
  cells?: { row: number; col: number; blockIds: string[] }[];
};

/** A tracked change inside a paragraph. An insertion spans the text it
 *  added; a deletion takes no place in the text read with the changes
 *  accepted, so its `start` and `end` are the one offset it was made at. */
type DocxBlockRevision = {
  kind: "insertion" | "deletion";
  start: number;
  end: number;
  author: string;
  date: string | null;
  /** The change is of a paragraph mark, not of text. */
  paragraphMark?: true;
};

/** A `REF` field of a paragraph: without a number switch it shows the
 *  content of the bookmark it names. */
type DocxBlockCrossReference = {
  /** The span of the paragraph's `text` the field's result takes. */
  start: number;
  end: number;
  /** The field's code as the document states it. */
  instruction: string;
  bookmark: string;
  /** The paragraph the bookmark starts and ends in; null when no bookmark
   *  of that name does both in one paragraph. */
  targetBlockId: string | null;
  /** Whether the bookmark holds all of that paragraph's content. */
  targetWhole: boolean;
};

/** One section of a document: how it begins after the one before it, and
 *  its page, in twentieths of a point. */
export type DocxSection = {
  index: number;
  start: "nextPage" | "evenPage" | "oddPage" | "nextColumn" | "continuous";
  orientation: "portrait" | "landscape";
  size: { width: number | null; height: number | null };
  margins: {
    top: number | null;
    right: number | null;
    bottom: number | null;
    left: number | null;
  };
  columns: number;
};

export type DocxBlockManifest = {
  sha256: string;
  blocks: DocxBlock[];
  /** The sections of the main story; a block names its own by
   *  `sectionIndex`. Absent from a manifest read before sections were
   *  reported. */
  sections?: DocxSection[];
  /** Compatibility settings of the document. Absent from a manifest read
   *  before they were reported, as are the blocks' alignments. */
  compat?: { doNotExpandShiftReturn: boolean };
  footnotes: { id: string; text: string }[];
  endnotes: { id: string; text: string }[];
  comments: number;
  trackedChanges: number;
  /** What the document tracks, when it tracks anything and was read as it
   *  stands. */
  revisions?: TrackedChanges;
  /** The view the manifest was read in and what was resolved for it:
   *  every block, label and hash is that view's. */
  trackedChangesResolved?: TrackedChanges & { view: TrackedChangesView };
  warnings: string[];
};

/** One of the two texts a document with tracked changes holds: with every
 *  change accepted, or with every change rejected. */
export type TrackedChangesView = "accept" | "reject";

/** The tracked changes of a document's main story and notes, by kind. */
export type TrackedChanges = {
  insertions: number;
  deletions: number;
  moves: number;
  /** Paragraph marks the view removes, each joining two paragraphs. */
  paragraphMarks: number;
  tableRows: number;
  formattingChanges: number;
  authors: string[];
  /** The earliest and the latest date a change states, as written. */
  first: string | null;
  last: string | null;
};

/** One numbering level of a template, as the template inspection reports it. */
export type TemplateNumberingLevel = {
  ilvl: number;
  numFmt: string;
  lvlText: string;
};

/** A paragraph indent in twentieths of a point; null where unstated. */
export type TemplateLevelIndent = {
  left: number | null;
  hanging: number | null;
  firstLine: number | null;
};

export type TemplateListLevel = TemplateNumberingLevel & {
  start: number;
  /** The paragraph style the level names as its own. */
  pStyle: string | null;
  indent: TemplateLevelIndent;
};

export type TemplateStyle = {
  styleId: string;
  name: string | null;
  type: "paragraph" | "character" | "numbering" | "table";
  basedOn: string | null;
  /** The list the style binds its paragraphs to, inheritance resolved. */
  numPr: { numId: number; ilvl: number } | null;
  outlineLvl: number | null;
  /** The paragraph alignment the style states (`w:jc`), inheritance
   *  resolved; null when none is stated. */
  alignment: string | null;
  /** Whether the style sets its text in bold, inheritance and the
   *  document's defaults resolved. Absent, like `size`, from an inspection
   *  read before the look was reported. */
  bold?: boolean;
  /** The font size the style gives its text, in half-points, inheritance
   *  and the document's defaults resolved; null when none states one. */
  size?: number | null;
  /** Whether the style keeps its paragraph with the next one. */
  keepNext?: boolean;
  /** The left indent the style gives its paragraphs, in twentieths of a
   *  point; null when none states one. Absent from an inspection read
   *  before it was reported. */
  indentLeft?: number | null;
  isDefault: boolean;
};

export type TemplateField = {
  /** Package path of the part holding the field. */
  part: string;
  /** The field name in upper case: `TOC`, `REF`, `FILLIN`, `DATE`. */
  kind: string;
  /** The field's code as the template writes it (`TOC \o "1-3" \h`).
   *  Absent from an inspection read before it was reported. */
  instruction?: string;
  /** Main story only: the top-level block the field starts in. */
  blockId?: string;
  /** Main story only: the top-level block the field ends in. A plan keeps
   *  every block from `blockId` to this one, or none of them. */
  endBlockId?: string;
};

/** What the engine reads off a template: its blocks in the manifest's flat
 *  shape, and the styles, lists and fields a profile is inferred from. */
export type TemplateInspection = {
  sha256: string;
  blocks: DocxBlock[];
  styles: TemplateStyle[];
  numbering: {
    abstractNums: { abstractNumId: number; levels: TemplateListLevel[] }[];
    nums: { numId: number; abstractNumId: number }[];
  };
  fields: TemplateField[];
  /** Text effects of the template whose values show nothing, each with
   *  what its run properties belong to. Absent from an inspection read
   *  before they were reported. */
  invisibleEffects?: TemplateInvisibleEffect[];
};

/** A text effect that shows nothing. It can still change how the text is
 *  treated: a run with a 3-D scene, even the default one, is drawn as a
 *  picture. The engine writes its output without such effects. */
type TemplateInvisibleEffect = {
  part: string;
  effect:
    | "glow"
    | "shadow"
    | "reflection"
    | "textOutline"
    | "textFill"
    | "scene3d"
    | "props3d";
  owner:
    | { kind: "level"; abstractNumId: number | null; ilvl: number | null }
    | { kind: "style"; styleId: string | null }
    | { kind: "defaults" }
    | { kind: "text" };
};

/** The list a placed paragraph joins. A number names a list of the
 *  template. Items that share a `group` are counted in one instance of that
 *  list, which the first of them starts; `restartFrom` is the number the
 *  instance begins the item's level with. */
export type TemplatePlanNumbering = {
  numId: number;
  ilvl: number;
  restartFrom?: number;
  group?: string;
};

type TemplatePlanMerge = "lineBreak" | "space" | "none";

/** How a paragraph's lines are set between the margins. */
export type TemplatePlanAlignment = "left" | "center" | "right" | "both";

/** The space in front of a paragraph and behind it, in twentieths of a
 *  point: at least one side. */
/** How a line spacing is counted: `auto` in 240ths of a line, `exact` and
 *  `atLeast` in twentieths of a point. */
export type TemplatePlanLineRule = "auto" | "exact" | "atLeast";

export type TemplatePlanSpacing = {
  before?: number;
  after?: number;
  /** The spacing of the paragraph's lines, counted by `lineRule` (`auto`
   *  when left out). Left out by an engine that does not know it. */
  line?: number;
  lineRule?: TemplatePlanLineRule;
};

export type TemplatePlanNestedParagraph = {
  blockId: string;
  styleId?: string;
  numbering?: TemplatePlanNumbering | null;
  stripLabel?: string;
  /** As on a source item. */
  labelAsText?: boolean;
  /** As on a source item. */
  alignment?: TemplatePlanAlignment;
  /** The paragraph's own space in front of it and behind it, over its
   *  style's; a side left out is the style's. Left out by an engine that
   *  does not know it. */
  spacing?: TemplatePlanSpacing;
};

/** A section of the output with a page other than the template's, in
 *  twentieths of a point. Everything else of it is the template's last
 *  section. */
export type TemplatePlanSection = {
  page?: {
    orientation: "portrait" | "landscape";
    width: number;
    height: number;
    margins?: { top: number; right: number; bottom: number; left: number };
  };
  /** How it begins after the section before it; `nextPage` when left out. */
  start?: "nextPage" | "evenPage" | "oddPage";
};

/** A paragraph indent a plan states; a side left out stays as it is. */
export type TemplatePlanIndent = {
  left?: number;
  hanging?: number;
  firstLine?: number;
};

export type TemplatePlanSourceItem = {
  kind: "source";
  blockId: string;
  hash: string;
  styleId?: string;
  /** `null` takes the paragraph out of any list. */
  numbering?: TemplatePlanNumbering | null;
  /** Literal manual label at the start of the block's text, removed. */
  stripLabel?: string;
  /** With `stripLabel`: a line break behind the label goes with it. For a
   *  heading the source breaks behind its number where the template sets
   *  number and title on one line. An engine that does not know the option
   *  leaves the break in the paragraph. */
  stripLabelBreak?: boolean;
  /** Writes the block's automatic label as text in front of its text, for
   *  a label no list of the template prints. The paragraph it leads joins
   *  no list. The engine writes only a label that reads the same wherever
   *  the file is opened: not a bullet glyph, not a number a language
   *  spells. */
  labelAsText?: boolean;
  /** Joins the next plan item, a bare source paragraph, into this one. */
  mergeNext?: TemplatePlanMerge;
  /** Starts the paragraph on a new page. Not for a table, nor for a block
   *  that joins the paragraph before it. */
  pageBreakBefore?: boolean;
  /** The paragraph is the last of the section described. Not for a table,
   *  nor for a block that joins the paragraph before it. */
  endsSection?: TemplatePlanSection;
  /** Keeps the paragraph on the page of the one after it. An engine that
   *  does not know the option writes the paragraph without it. */
  keepNext?: boolean;
  /** The paragraph's own indent, over its style's and its list level's,
   *  in twentieths of a point. As `keepNext`, it is left out by an engine
   *  that does not know it. */
  indent?: TemplatePlanIndent;
  /** The paragraph's own left tab stops, in twentieths of a point from
   *  the left margin, ascending. As `keepNext`, left out by an engine that
   *  does not know them. */
  tabStops?: number[];
  /** The paragraph's own alignment, over its style's. As `keepNext`, left
   *  out by an engine that does not know it. */
  alignment?: TemplatePlanAlignment;
  /** Table only: the paragraph style of its cells. */
  cellStyleId?: string;
  /** Table only: placement of single paragraphs inside it. */
  nested?: TemplatePlanNestedParagraph[];
};

type TemplatePlanItem =
  | { kind: "template"; templateBlockIds: string[] }
  | TemplatePlanSourceItem
  | {
      kind: "slot";
      templateBlockId: string;
      sourceBlockIds: string[];
      /** A lead of the first source block the slot does not take: the name
       *  of a field that the kept template paragraph named here shows. The
       *  rest is placed word for word. An engine that does not know the
       *  option places the block whole. */
      dropLead?: { text: string; shownByTemplateBlockId: string };
    };

type TemplatePlanOmitReason =
  "empty" | "sourceToc" | "pageArtifact" | "duplicateLabel";

export type TemplatePlanReference = {
  blockId: string;
  start: number;
  end: number;
  targetBlockId: string;
  /** REF field switches, e.g. `\n \t \h`. */
  instruction: string;
  expectedText: string;
};

export type TemplatePlanHighlight = {
  blockId: string;
  start: number;
  end: number;
  color: string;
};

export type TemplatePlanNumberingPatch = {
  abstractNumId: number;
  ilvl: number;
  numFmt?: string;
  lvlText?: string;
  /** What follows the label. */
  suff?: "tab" | "space" | "nothing";
  /** The face the level's label is set in: for a bullet whose mark is a
   *  character of a text face. */
  font?: string;
  /** The level's paragraph indent, in twentieths of a point; a value left
   *  out keeps what the level states. */
  indent?: { left?: number; hanging?: number; firstLine?: number };
};

export type TemplatePlan = {
  version: 1;
  sourceSha256: string;
  templateSha256: string;
  body: TemplatePlanItem[];
  omit: { blockId: string; reason: TemplatePlanOmitReason }[];
  numberingPatches?: TemplatePlanNumberingPatch[];
  references?: TemplatePlanReference[];
  highlights?: TemplatePlanHighlight[];
  fields?: { freezeKinds?: string[]; updateOnOpen?: boolean };
  /** Compatibility settings switched on in the output's settings, which
   *  are otherwise the template's. */
  compat?: { doNotExpandShiftReturn?: boolean };
  /** The section the body ends with, when its page is another than the
   *  template's. */
  lastSection?: TemplatePlanSection;
  /** Paragraphs inside kept template tables written without their text.
   *  An engine that does not know the option leaves them as they are. */
  emptyTemplateBlockIds?: string[];
  /** The view of a source with tracked changes the plan is made for. The
   *  output carries no revision. */
  trackedChanges?: TrackedChangesView;
};

/** The part of the engine's report the plan is repaired and the formatting
 *  note is written from. */
export type TemplatePlanReport = {
  ok: boolean;
  blocks: {
    blockId: string;
    disposition: "placed" | "merged" | "slot" | "nested" | "omitted";
    /** The label the source showed: automatic, else the stripped one. */
    sourceLabel: string | null;
    /** The automatic label the output paragraph renders. */
    outputLabel: string | null;
    /** The automatic label written as text in front of the block. */
    labelAsText?: string;
  }[];
  references: {
    results: {
      blockId: string;
      targetBlockId: string;
      expectedText: string;
      /** What the target's rendered label gives for the field; null when
       *  it is not derived. */
      predictedText: string | null;
    }[];
  };
  footnotes: { source: number; output: number };
  endnotes: { source: number; output: number };
  leftovers: {
    fields: { part: string; kind: string; count: number }[];
    frozenFields: { part: string; kind: string; count: number }[];
    filler: { part: string; count: number }[];
  };
  dropped: {
    comments: number;
    sourceFields: { kind: string; count: number }[];
    internalHyperlinks: number;
    sectionBreaks: number;
  };
};

/** Why the engine refused; the codes a plan can be repaired after. Any
 *  other refusal is `other`. */
export type TemplateEngineRefusal =
  | "strip-label-mismatch"
  /** The automatic label of the block cannot stand as text. */
  | "label-not-writable"
  | "merge-invalid"
  | "reference-span-invalid"
  | "reference-target-unplaced"
  | "highlight-span-invalid"
  | "tracked-changes"
  | "unsupported-content"
  /** The source or the template is no package the engine can open. */
  | "archive-unreadable"
  /** The output was written and did not hold up against the plan. */
  | "verification-failed"
  | "other";

export class TemplateEngineError extends TaggedError("TemplateEngineError")<{
  message: string;
  reason: TemplateEngineRefusal;
  /** The source block the refusal names. */
  blockId?: string;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type TemplateEngineApplyArgs = {
  source: Uint8Array;
  template: Uint8Array;
  plan: TemplatePlan;
  /** Template placeholder strings the report counts in the output. */
  fillerStrings: readonly string[];
};

/** Page geometry of one document as the layout engine paginates it. */
type TemplateLayoutSignals = { pages: number };

/** The DOCX engine behind this directory. Injected, so the rules here do
 *  not depend on the package release that carries it. */
export type TemplatePlanEngine = {
  /** With `trackedChanges`, the manifest of that view of a document with
   *  tracked changes. An engine that cannot read a view answers as if none
   *  was asked for. */
  analyze: (
    docx: Uint8Array,
    options?: { trackedChanges?: TrackedChangesView },
  ) => Promise<Result<DocxBlockManifest, TemplateEngineError>>;
  inspect: (
    docx: Uint8Array,
  ) => Promise<Result<TemplateInspection, TemplateEngineError>>;
  apply: (
    args: TemplateEngineApplyArgs,
  ) => Promise<
    Result<
      { docx: Uint8Array; report: TemplatePlanReport },
      TemplateEngineError
    >
  >;
  /** The highlight colours the document's own text carries, so a mark the
   *  plan adds can be told from a blank the author highlighted. */
  highlightColors: (
    docx: Uint8Array,
  ) => Promise<Result<string[], TemplateEngineError>>;
  /** Absent where no layout backend is installed. */
  layout?: (
    docx: Uint8Array,
  ) => Promise<Result<TemplateLayoutSignals, TemplateEngineError>>;
};

const MANUAL_LABEL_MAX = 40;
const MANUAL_LABEL_WORDS_MAX = 3;
const MANUAL_LABEL_WORD = /^(?:\p{L}[\p{L}\p{M}]*\.?|§{1,2}|№|#)$/u;
const MANUAL_LABEL_DESIGNATOR =
  /^[([]?(?<core>\d+(?:[.\-\u2013]\d+)*[a-z]?|\p{L}+)[)\]]?[.:)]*$/u;
const MANUAL_LABEL_BULLET = /^[-\u2013\u2014\u2022\u00B7\u25AA\u25E6*]$/u;
const MANUAL_LABEL_ROMAN =
  /^(?=.)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/iu;
const MANUAL_LABEL_END = /^[ \t\u00A0\n]$/u;
/** A number of several parts typed with blanks between them: `1. 1.`. */
const MANUAL_LABEL_SPACED_NUMBER = /^\d{1,3}\.(?:[ \u00A0]+\d{1,3}\.){1,3}$/u;

/**
 * Whether the engine will strip `label` from the start of `text`: up to
 * three words and one designator (a number, a roman numeral or a letter with
 * its punctuation), a single bullet, or a number whose parts stand apart
 * (`1. 1.`), ending where a word would. The engine
 * refuses any other strip, so a label that fails here stays in the text.
 */
export const isStrippableLabel = (label: string, text: string): boolean => {
  if (label === "" || label.length > MANUAL_LABEL_MAX) {
    return false;
  }
  const lead = /^[ \t\u00A0]*/u.exec(text)?.[0].length ?? 0;
  const end = lead + label.length;
  if (
    !text.startsWith(label, lead) ||
    !(end === text.length || MANUAL_LABEL_END.test(text.charAt(end)))
  ) {
    return false;
  }
  if (
    MANUAL_LABEL_BULLET.test(label) ||
    MANUAL_LABEL_SPACED_NUMBER.test(label)
  ) {
    return true;
  }
  const tokens = label.split(/[ \u00A0]/u);
  const core = MANUAL_LABEL_DESIGNATOR.exec(tokens.at(-1) ?? "")?.groups?.[
    "core"
  ];
  const words = tokens.slice(0, -1);
  return (
    core !== undefined &&
    words.length <= MANUAL_LABEL_WORDS_MAX &&
    words.every((word) => MANUAL_LABEL_WORD.test(word)) &&
    (/^\d/u.test(core) || core.length === 1 || MANUAL_LABEL_ROMAN.test(core))
  );
};

const blockNumberingSchema = v.strictObject({
  numId: v.pipe(v.number(), v.integer()),
  ilvl: v.pipe(v.number(), v.integer(), v.minValue(0)),
  abstractNumId: v.pipe(v.number(), v.integer()),
  bullet: v.exactOptional(v.literal(true)),
  bulletFont: v.exactOptional(v.pipe(v.string(), v.minLength(1))),
});

const blockSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  kind: v.picklist(["paragraph", "table"]),
  text: v.string(),
  label: v.nullable(v.string()),
  numbering: v.nullable(blockNumberingSchema),
  styleId: v.nullable(v.string()),
  styleName: v.nullable(v.string()),
  outlineLevel: v.nullable(v.pipe(v.number(), v.integer())),
  sectionIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
  hash: v.string(),
  inlineObjects: v.exactOptional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  pageBreaks: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  selfNumbers: v.exactOptional(
    v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
  ),
  revisions: v.exactOptional(
    v.array(
      v.strictObject({
        kind: v.picklist(["insertion", "deletion"]),
        start: v.pipe(v.number(), v.integer(), v.minValue(0)),
        end: v.pipe(v.number(), v.integer(), v.minValue(0)),
        author: v.string(),
        date: v.nullable(v.string()),
        paragraphMark: v.exactOptional(v.literal(true)),
      }),
    ),
  ),
  crossReferences: v.exactOptional(
    v.array(
      v.strictObject({
        start: v.pipe(v.number(), v.integer(), v.minValue(0)),
        end: v.pipe(v.number(), v.integer(), v.minValue(0)),
        instruction: v.string(),
        bookmark: v.string(),
        targetBlockId: v.nullable(v.string()),
        targetWhole: v.boolean(),
      }),
    ),
  ),
  pageBreakBefore: v.exactOptional(v.literal(true)),
  endsSection: v.exactOptional(v.literal(true)),
  alignment: v.exactOptional(v.string()),
  spacing: v.exactOptional(
    v.strictObject({
      before: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      after: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
  ),
  spacingInEffect: v.exactOptional(
    v.strictObject({
      before: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      after: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      line: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      lineRule: v.exactOptional(v.picklist(["auto", "exact", "atLeast"])),
    }),
  ),
  indent: v.exactOptional(
    v.strictObject({
      left: v.pipe(v.number(), v.integer()),
      firstLine: v.pipe(v.number(), v.integer()),
    }),
  ),
  cells: v.exactOptional(
    v.array(
      v.strictObject({
        row: v.pipe(v.number(), v.integer(), v.minValue(0)),
        col: v.pipe(v.number(), v.integer(), v.minValue(0)),
        blockIds: v.array(v.string()),
      }),
    ),
  ),
});

const noteSchema = v.strictObject({ id: v.string(), text: v.string() });

const twips = v.nullable(v.pipe(v.number(), v.integer()));

const sectionSchema = v.strictObject({
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  start: v.picklist([
    "nextPage",
    "evenPage",
    "oddPage",
    "nextColumn",
    "continuous",
  ]),
  orientation: v.picklist(["portrait", "landscape"]),
  size: v.strictObject({ width: twips, height: twips }),
  margins: v.strictObject({
    top: twips,
    right: twips,
    bottom: twips,
    left: twips,
  }),
  columns: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const REVISION_AUTHORS_MAX = 1000;
const trackedChangesSchema = v.strictObject({
  insertions: count,
  deletions: count,
  moves: count,
  paragraphMarks: count,
  tableRows: count,
  formattingChanges: count,
  authors: v.pipe(v.array(v.string()), v.maxLength(REVISION_AUTHORS_MAX)),
  first: v.nullable(v.string()),
  last: v.nullable(v.string()),
});

const manifestSchema = v.strictObject({
  sha256: v.string(),
  blocks: v.array(blockSchema),
  sections: v.exactOptional(v.array(sectionSchema)),
  compat: v.exactOptional(
    v.strictObject({ doNotExpandShiftReturn: v.boolean() }),
  ),
  footnotes: v.array(noteSchema),
  endnotes: v.array(noteSchema),
  comments: v.pipe(v.number(), v.integer(), v.minValue(0)),
  trackedChanges: v.pipe(v.number(), v.integer(), v.minValue(0)),
  revisions: v.exactOptional(trackedChangesSchema),
  trackedChangesResolved: v.exactOptional(
    v.strictObject({
      ...trackedChangesSchema.entries,
      view: v.picklist(["accept", "reject"]),
    }),
  ),
  warnings: v.array(v.string()),
});

class DocxBlockManifestError extends TaggedError("DocxBlockManifestError")<{
  message: string;
}> {}

/** Reads a manifest that crossed a process or storage boundary (a stored
 *  analysis, a scoring corpus). Block ids must be unique: every index in this
 *  directory is keyed by them. */
export const parseDocxBlockManifest = (
  input: unknown,
): Result<DocxBlockManifest, DocxBlockManifestError> => {
  const parsed = v.safeParse(manifestSchema, input);
  if (!parsed.success) {
    return Result.err(
      new DocxBlockManifestError({
        // The path only: an issue's own message can quote the received
        // value, which is document text.
        message: `Block manifest does not match the contract at ${v.getDotPath(parsed.issues[0]) ?? "the root"}`,
      }),
    );
  }
  const seen = new Set<string>();
  for (const block of parsed.output.blocks) {
    if (seen.has(block.id)) {
      return Result.err(
        new DocxBlockManifestError({
          message: "Block manifest repeats a block id",
        }),
      );
    }
    seen.add(block.id);
  }
  return Result.ok(parsed.output);
};
