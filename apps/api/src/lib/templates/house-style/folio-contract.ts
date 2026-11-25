// Local copy of the block-manifest and template-plan contract that the DOCX
// engine exposes. Replace this file with the `@stll/folio-core/server` import
// once the release carrying `analyzeDocxBlocks` and `applyTemplatePlan` is
// pinned; nothing else in this directory restates these shapes.

import { Result, TaggedError } from "better-result";
import * as v from "valibot";

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

export type TemplatePlanSourceItem = {
  kind: "source";
  blockId: string;
  hash: string;
  styleId?: string;
  /** `null` takes the paragraph out of any list. */
  numbering?: {
    numId: number | "new";
    ilvl: number;
    restartFrom?: number;
  } | null;
  /** Literal manual label at the start of the block's text, removed. */
  stripLabel?: string;
  /** Joins the next source block into this paragraph (split headings). */
  mergeNext?: "lineBreak" | "space";
};

type TemplatePlanItem =
  | { kind: "template"; templateBlockIds: string[] }
  | TemplatePlanSourceItem
  | { kind: "slot"; templateBlockId: string; sourceBlockIds: string[] };

type TemplatePlanOmitReason =
  "empty" | "sourceToc" | "pageArtifact" | "duplicateLabel";

type TemplatePlanReference = {
  blockId: string;
  start: number;
  end: number;
  targetBlockId: string;
  /** REF field switches, e.g. `\n \t \h`. */
  instruction: string;
  expectedText: string;
};

export type TemplatePlan = {
  version: 1;
  sourceSha256: string;
  templateSha256: string;
  body: TemplatePlanItem[];
  omit: { blockId: string; reason: TemplatePlanOmitReason }[];
  numberingPatches?: {
    abstractNumId: number;
    ilvl: number;
    numFmt?: string;
    lvlText?: string;
    start?: number;
    suff?: "tab" | "space" | "nothing";
  }[];
  references?: TemplatePlanReference[];
  highlights?: {
    blockId: string;
    start: number;
    end: number;
    color: string;
    note?: string;
  }[];
  fields?: { freezeKinds?: string[]; updateOnOpen?: boolean };
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
