/**
 * The System One half of a matter-table extraction batch.
 *
 * A property whose answer space is closed (a select, a date, an integer) is a
 * judgment over the matter's files, not a generation, so Jev answers it from
 * the same files the generative model reads. This module holds that path's
 * pure logic: the sources a prepared file yields, the split by kind, and the
 * outcomes read back as the `WorkflowDataOutput` entries the generative path
 * writes. The request itself lives in `ai-generate-batch.ts`.
 *
 * A cited answer may only carry a locator the justification validators
 * already accept: a bates stamp for a PDF page, a folio block id for a DOCX
 * block. Extracted text and text inputs have no locator at all, exactly as in
 * the generative prompt, so an answer from one of them is written without a
 * citation rather than with an invented one.
 */

import { PDF } from "@libpdf/core";
import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type {
  AnswerOutcome,
  AnswerQuestion,
  AnswerSource,
} from "@/api/lib/decisions/answer-questions";
import {
  isSystemOneAnswerable,
  SYSTEM_ONE_SOURCE_BUDGET_CHARS,
} from "@/api/lib/decisions/answer-questions";
import type { WorkflowDataOutput } from "@/api/lib/workflow/ai-generate-batch";
import type {
  PreparedInputFile,
  PreparedPdfFile,
} from "@/api/lib/workflow/generate-batch";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { AIJustificationOutput } from "@/api/lib/workflow/parse-justifications";

/**
 * The batch carries no locale: a matter's files are not tagged with a
 * language and `GenerateWorkflowDataProps` never took one. English is the
 * reading convention for the date and number candidates until the batch
 * carries the matter's locale end to end.
 */
export const SYSTEM_ONE_BATCH_LANGUAGE = "en";

/**
 * The page stamp `addBatesNumbers` draws, and the citation the justification
 * validators parse back. Owned here because the System One sources cite the
 * same stamp: one format, one definition.
 */
export const batesStamp = (simplifiedName: string, pageIndex: number): string =>
  `${simplifiedName}-${String(pageIndex + 1).padStart(4, "0")}`;

/**
 * Where a source sits, for the justification an accepted answer carries.
 * `uncited` keeps a citation structurally impossible for a source that has no
 * locator, rather than leaving it to the caller's discipline.
 */
export type SourceLocator =
  | { type: "cited"; file: string; citation: string }
  | { type: "uncited" };

export type BatchSources = {
  sources: AnswerSource[];
  locators: Map<string, SourceLocator>;
};

type LocatedSource = { source: AnswerSource; locator: SourceLocator };

const pdfPageSources = async (
  file: PreparedPdfFile,
): Promise<LocatedSource[]> => {
  const pdf = await PDF.load(file.content);
  const located: LocatedSource[] = [];
  for (const page of pdf.extractText()) {
    const stamp = batesStamp(file.simplifiedName, page.pageIndex);
    // The prepared bytes carry the stamp drawn in all four corners, so it
    // reads back as page text; dropping it keeps it out of the date and
    // number candidates the plan offers.
    const text = page.text.replaceAll(stamp, " ").trim();
    if (text.length === 0) {
      continue;
    }
    located.push({
      source: { id: stamp, text },
      locator: { type: "cited", file: file.simplifiedName, citation: stamp },
    });
  }
  return located;
};

const PARAGRAPH_BREAK = /\n\s*\n/u;

/** DOCX block ids are only unique within one file, not across a batch. */
const docxSourceId = (simplifiedName: string, blockId: string): string =>
  `${simplifiedName}#${blockId}`;

const fileSources = async (
  file: PreparedInputFile,
): Promise<LocatedSource[]> => {
  switch (file.kind) {
    case "pdf":
      return await pdfPageSources(file);
    case "docx":
      return file.blocks.flatMap((block) =>
        block.text.trim().length === 0
          ? []
          : [
              {
                source: {
                  id: docxSourceId(file.simplifiedName, block.id),
                  text: block.text,
                },
                locator: {
                  type: "cited",
                  file: file.simplifiedName,
                  citation: block.id,
                },
              } satisfies LocatedSource,
            ],
      );
    case "extracted-text":
      return file.content
        .split(PARAGRAPH_BREAK)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0)
        .map((paragraph, index) => ({
          source: {
            id: `${file.simplifiedName}#${String(index + 1)}`,
            text: paragraph,
          },
          locator: { type: "uncited" },
        }));
    default:
      file satisfies never;
      return panic("Unhandled prepared input file kind");
  }
};

/**
 * The batch's files and text inputs as System One sources, in the order the
 * generative prompt presents them, trimmed to the per-request budget. A
 * source that does not fit what the budget has left is dropped and the
 * shorter ones after it are still offered, so one long page cannot cut off
 * the rest of the matter.
 */
export const sourcesFromPreparedFiles = async (
  files: readonly PreparedInputFile[],
  textInputs: readonly TextInput[],
): Promise<BatchSources> => {
  const perFile = await Promise.all(files.map(fileSources));
  const located: LocatedSource[] = perFile.flat();
  for (const { propertyId, value } of textInputs) {
    const text = value.trim();
    if (text.length === 0) {
      continue;
    }
    located.push({
      source: { id: `input-${propertyId}`, text },
      locator: { type: "uncited" },
    });
  }

  const sources: AnswerSource[] = [];
  const locators = new Map<string, SourceLocator>();
  let used = 0;
  for (const entry of located) {
    if (used + entry.source.text.length > SYSTEM_ONE_SOURCE_BUDGET_CHARS) {
      continue;
    }
    used += entry.source.text.length;
    sources.push(entry.source);
    locators.set(entry.source.id, entry.locator);
  }
  return { sources, locators };
};

/** Named facts about the row; the file names the prompt already uses, nothing else. */
export const systemOneDocumentHeader = (
  files: readonly PreparedInputFile[],
): Record<string, string> => ({
  files: files.map((file) => file.simplifiedName).join(", "),
});

export type SystemOnePropertySplit = {
  systemOne: AIBatchProperty[];
  generative: AIBatchProperty[];
};

export const splitPropertiesForSystemOne = (
  properties: readonly AIBatchProperty[],
): SystemOnePropertySplit => {
  const systemOne: AIBatchProperty[] = [];
  const generative: AIBatchProperty[] = [];
  for (const property of properties) {
    if (isSystemOneAnswerable(property.content)) {
      systemOne.push(property);
      continue;
    }
    generative.push(property);
  }
  return { systemOne, generative };
};

/** One question per property: the column's prompt, asked under the property id. */
export const questionsFromProperties = (
  properties: readonly AIBatchProperty[],
): AnswerQuestion[] =>
  properties.flatMap((property) =>
    isSystemOneAnswerable(property.content)
      ? [
          {
            id: property.id,
            question: property.tool.prompt,
            content: property.content,
          },
        ]
      : [],
  );

const justificationFor = (
  rationale: string,
  locator: SourceLocator | undefined,
): AIJustificationOutput =>
  locator === undefined || locator.type === "uncited"
    ? []
    : [
        {
          file: locator.file,
          statements: [{ text: rationale, citations: [locator.citation] }],
        },
      ];

export type SystemOneOutcomeOptions = {
  /** The properties asked of System One, in batch order. */
  properties: readonly AIBatchProperty[];
  outcomes: ReadonlyMap<string, AnswerOutcome>;
  locators: ReadonlyMap<string, SourceLocator>;
};

export type SystemOneOutcomeResult = {
  output: WorkflowDataOutput;
  /** Properties the generative model must still answer: unplanned or undecided. */
  fallbackPropertyIds: SafeId<"property">[];
};

/**
 * Settled outcomes as batch output. An undecided property, and one the plan
 * could not ask, falls back to the generative model: a judgment the decision
 * model did not take is not written over an answer the other path could still
 * produce. "Not stated" is an answer, and `null` is how the generative path
 * writes it.
 */
export const outputFromSystemOneOutcomes = ({
  properties,
  outcomes,
  locators,
}: SystemOneOutcomeOptions): SystemOneOutcomeResult => {
  const output: WorkflowDataOutput = {};
  const fallbackPropertyIds: SafeId<"property">[] = [];
  for (const property of properties) {
    const outcome = outcomes.get(property.id);
    if (outcome === undefined) {
      fallbackPropertyIds.push(property.id);
      continue;
    }
    switch (outcome.state) {
      case "undecided":
        fallbackPropertyIds.push(property.id);
        break;
      case "not_stated":
        output[property.id] = { answer: null, justification: [] };
        break;
      case "answered":
        output[property.id] = {
          answer: outcome.answer,
          justification: justificationFor(
            outcome.rationale,
            outcome.sourceId === null
              ? undefined
              : locators.get(outcome.sourceId),
          ),
        };
        break;
      default:
        outcome satisfies never;
        panic("Unhandled System One outcome state");
    }
  }
  return { output, fallbackPropertyIds };
};
