// The DOCX engine behind this directory: the folio package's block analysis,
// template inspection and plan application, in the shape `TemplatePlanEngine`
// asks for. Everything else here stays free of the package: it reads and
// writes the contract in `folio-contract.ts`, and this file is where the two
// are held against each other by the compiler.

import { Result } from "better-result";

import { ZipArchive } from "@stll/docx-core/zip";
import {
  analyzeDocxBlocks,
  applyTemplatePlan,
  inspectDocxTemplate,
} from "@stll/folio-core/server";
import type {
  DocxBlock as EngineBlock,
  TemplatePlanError,
} from "@stll/folio-core/server";

import { TemplateEngineError } from "@/api/lib/templates/house-style/folio-contract";
import type {
  DocxBlock,
  TemplateEngineRefusal,
  TemplatePlanEngine,
} from "@/api/lib/templates/house-style/folio-contract";

/** What each of the engine's refusals is to the plan steps: one they repair
 *  or report by name, or `other`. Total over the engine's codes, so a code a
 *  later release adds does not compile until it is placed. */
const REFUSALS = {
  "archive-unreadable": "archive-unreadable",
  "part-missing": "other",
  "xml-unreadable": "other",
  "plan-invalid": "other",
  "sha-mismatch": "other",
  "unknown-block": "other",
  "hash-mismatch": "other",
  "block-unplaced": "other",
  "block-placed-twice": "other",
  "strip-label-mismatch": "strip-label-mismatch",
  "label-not-writable": "label-not-writable",
  "merge-invalid": "merge-invalid",
  "reference-span-invalid": "reference-span-invalid",
  "reference-target-unplaced": "reference-target-unplaced",
  "highlight-span-invalid": "highlight-span-invalid",
  "numbering-unknown": "other",
  "style-unknown": "other",
  "tracked-changes": "tracked-changes",
  "unsupported-content": "unsupported-content",
  "verification-failed": "verification-failed",
} as const satisfies Record<TemplatePlanError["code"], TemplateEngineRefusal>;

const refused = ({
  code,
  message,
  blockId,
}: TemplatePlanError): TemplateEngineError =>
  new TemplateEngineError({
    message,
    reason: REFUSALS[code],
    ...(blockId === undefined ? {} : { blockId }),
  });

const NO_BLOCKS: readonly EngineBlock[] = [];

/** The engine nests a table's paragraphs in the table; the contract lists
 *  every block once, a table in front of its cells' paragraphs. */
const flattenBlocks = (blocks: readonly EngineBlock[]): DocxBlock[] => {
  const seen = new Set<string>();
  const flat: DocxBlock[] = [];
  const push = ({
    nested: _nested,
    paraId: _paraId,
    ...block
  }: EngineBlock) => {
    if (!seen.has(block.id)) {
      seen.add(block.id);
      flat.push(block);
    }
  };
  for (const block of blocks) {
    push(block);
    for (const inner of block.nested ?? NO_BLOCKS) {
      push(inner);
    }
  }
  return flat;
};

/** The story parts whose text a plan may highlight. */
const STORY_PARTS = [
  "word/document.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
] as const;
// XML allows either quote around an attribute value.
const HIGHLIGHT =
  /<w:highlight\b[^>]*\bw:val=(?<quote>["'])(?<color>[A-Za-z]{1,20})\k<quote>/gu;

const readHighlightColors = async (docx: Uint8Array): Promise<string[]> => {
  const archive = await ZipArchive.read(docx);
  const colors = new Set<string>();
  for (const path of STORY_PARTS) {
    const xml = (await archive.entry(path)?.text()) ?? "";
    for (const match of xml.matchAll(HIGHLIGHT)) {
      const color = match.groups?.["color"];
      if (color !== undefined && color !== "none") {
        colors.add(color);
      }
    }
  }
  return [...colors];
};

/**
 * The engine over the installed folio package. It has no layout backend:
 * page counts are measured where a font-carrying layout is set up.
 */
export const folioTemplatePlanEngine: TemplatePlanEngine = {
  analyze: async (docx, options) => {
    // One view of a document with tracked changes, or its accepted view
    // with the changes kept, when the caller names it; without a choice
    // the engine reads the document as it stands.
    const view = options?.trackedChanges;
    const analyzed = await analyzeDocxBlocks(
      docx,
      view === undefined ? {} : { trackedChanges: view },
    );
    return analyzed.isErr()
      ? Result.err(refused(analyzed.error))
      : Result.ok({
          ...analyzed.value,
          blocks: flattenBlocks(analyzed.value.blocks),
        });
  },
  inspect: async (docx) => {
    const inspected = await inspectDocxTemplate(docx);
    if (inspected.isErr()) {
      return Result.err(refused(inspected.error));
    }
    const { sha256, blocks, styles, numbering, fields } = inspected.value;
    return Result.ok({
      sha256,
      blocks: flattenBlocks(blocks),
      styles,
      numbering,
      fields,
    });
  },
  apply: async ({ source, template, plan, fillerStrings }) => {
    const applied = await applyTemplatePlan({
      source,
      template,
      plan,
      options: { fillerStrings },
    });
    return applied.isErr()
      ? Result.err(refused(applied.error))
      : Result.ok(applied.value);
  },
  highlightColors: async (docx) => {
    const colors = await Result.tryPromise(
      async () => await readHighlightColors(docx),
    );
    return colors.isErr()
      ? Result.err(
          new TemplateEngineError({
            message: "The document's parts could not be read",
            reason: "other",
          }),
        )
      : Result.ok(colors.value);
  },
};
