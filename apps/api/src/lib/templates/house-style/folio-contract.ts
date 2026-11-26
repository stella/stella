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
  numbering: { numId: number; ilvl: number; abstractNumId: number } | null;
  styleId: string | null;
  styleName: string | null;
  outlineLevel: number | null;
  sectionIndex: number;
  /** Short hash of text and label; a plan pins a block with it. */
  hash: string;
  /** Pictures, drawings and embedded objects anchored in the block; a block
   *  that holds one is not empty even without text. */
  inlineObjects?: number;
  cells?: { row: number; col: number; blockIds: string[] }[];
};

export type DocxBlockManifest = {
  sha256: string;
  blocks: DocxBlock[];
  footnotes: { id: string; text: string }[];
  endnotes: { id: string; text: string }[];
  comments: number;
  trackedChanges: number;
  warnings: string[];
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
  isDefault: boolean;
};

export type TemplateField = {
  /** Package path of the part holding the field. */
  part: string;
  /** The field name in upper case: `TOC`, `REF`, `FILLIN`, `DATE`. */
  kind: string;
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

export type TemplatePlanNestedParagraph = {
  blockId: string;
  styleId?: string;
  numbering?: TemplatePlanNumbering | null;
  stripLabel?: string;
  /** As on a source item. */
  labelAsText?: boolean;
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
  /** Writes the block's automatic label as text in front of its text, for
   *  a label no list of the template prints. The paragraph it leads joins
   *  no list. The engine writes only a label that reads the same wherever
   *  the file is opened: not a bullet glyph, not a number a language
   *  spells. */
  labelAsText?: boolean;
  /** Joins the next plan item, a bare source paragraph, into this one. */
  mergeNext?: TemplatePlanMerge;
  /** Table only: the paragraph style of its cells. */
  cellStyleId?: string;
  /** Table only: placement of single paragraphs inside it. */
  nested?: TemplatePlanNestedParagraph[];
};

type TemplatePlanItem =
  | { kind: "template"; templateBlockIds: string[] }
  | TemplatePlanSourceItem
  | { kind: "slot"; templateBlockId: string; sourceBlockIds: string[] };

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
  analyze: (
    docx: Uint8Array,
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

/**
 * Whether the engine will strip `label` from the start of `text`: up to
 * three words and one designator (a number, a roman numeral or a letter with
 * its punctuation) or a single bullet, ending where a word would. The engine
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
  if (MANUAL_LABEL_BULLET.test(label)) {
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

const manifestSchema = v.strictObject({
  sha256: v.string(),
  blocks: v.array(blockSchema),
  footnotes: v.array(noteSchema),
  endnotes: v.array(noteSchema),
  comments: v.pipe(v.number(), v.integer(), v.minValue(0)),
  trackedChanges: v.pipe(v.number(), v.integer(), v.minValue(0)),
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
