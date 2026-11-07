import { panic } from "better-result";
import * as v from "valibot";

import type { FolioAIBlock } from "@stll/folio-core/server";

import { DOCX_REVIEW_MARKUP_EXAMPLES } from "@/api/lib/docx-review-markup";
import { logger } from "@/api/lib/observability/logger";
import type { PromptSafeText } from "@/api/lib/prompt-safety";
import { answerSchemaForShape } from "@/api/lib/workflow/ai-answer-schema";
import type { Answer, AnswerShape } from "@/api/lib/workflow/ai-answer-schema";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";

// --------------- System prompts ---------------

export const WORKFLOW_SYSTEM_PROMPT =
  "You are a helpful legal assistant that analyzes the content " +
  "of the attached files and answers multiple prompts at once. " +
  "Return an object whose keys are exactly the provided " +
  "propertyIds and values contain the answer and justification " +
  "for each propertyId. The justification schema for the current " +
  "batch tells you exactly how to cite each source. " +
  "When the source does not state a property's value, answer null " +
  "for that property; never invent or guess a value. " +
  "DOCX block text may contain review tags: " +
  `${DOCX_REVIEW_MARKUP_EXAMPLES.insertion}, ` +
  `${DOCX_REVIEW_MARKUP_EXAMPLES.deletion}, and ` +
  `${DOCX_REVIEW_MARKUP_EXAMPLES.comment}. Treat insert tags as text that ` +
  "belongs to the reviewed version, delete tags as text that was removed, " +
  "and comment tags as reviewer notes attached near the surrounding text. " +
  "Use tag attributes such as author, initials, date, status, and thread " +
  "when the prompt asks who made a change, when it was made, or whether a " +
  "comment is resolved or a reply. " +
  "Use these tags when the prompt asks about edits, prior wording, removed " +
  "language, additions, redlines, or comments. Otherwise answer without " +
  "showing the tag syntax.";

// A guard against a malformed document, not a budget: one paragraph can hold a
// whole clause, and grading sees only what extraction could read. Matches the
// per-file limit on extracted text.
export const DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS = 40_000;

/** Ends any prompt input that was cut, so the model knows text is missing. */
export const PROMPT_TRUNCATION_MARKER =
  "\n\n[… content truncated to fit AI prompt limits …]";

export const PROMPT_INPUT_TRUNCATED_EVENT = "workflow.prompt_input_truncated";

type PromptInputTruncation = {
  input: "docx_blocks" | "extracted_text";
  truncatedParts: number;
  droppedChars: number;
  maxChars: number;
};

/** Records each cut prompt input, so a cut is counted rather than silent. */
export const recordPromptInputTruncation = ({
  input,
  truncatedParts,
  droppedChars,
  maxChars,
}: PromptInputTruncation): void => {
  if (truncatedParts === 0) {
    return;
  }
  logger.info(PROMPT_INPUT_TRUNCATED_EVENT, {
    input,
    truncated_parts: String(truncatedParts),
    dropped_chars: String(droppedChars),
    max_chars: String(maxChars),
  });
};

export const buildExtractedFileMessage = ({
  content,
  simplifiedName,
}: {
  content: PromptSafeText;
  simplifiedName: string;
}): string =>
  [
    `EXTRACTED FILE ${simplifiedName}:`,
    "This source has text content but no navigable citation locator. Analyze it normally; the justification schema will omit it.",
    content,
  ].join("\n\n");

// --------------- Schema builders ---------------

const CITE_EVERY_TERM_INSTRUCTION =
  "Cite every block that states a term the question covers, including any " +
  "definition or sub-clause those terms rely on: a reviewer reads the exact " +
  "wording of the cited blocks and nothing else, so a term in an uncited block " +
  "counts as absent. Cite the block holding the main term first, and do not " +
  'cite a block that only holds a heading. Keep "text" to a few words; one ' +
  "statement can carry all the citations.";

const citationInstructions = (shape: AnswerShape): string[] => {
  switch (shape) {
    case "clause-summary":
      return [CITE_EVERY_TERM_INSTRUCTION];
    case "value":
    case "clause-quote":
      return [];
    default:
      shape satisfies never;
      return panic(`Unhandled answer shape: ${String(shape)}`);
  }
};

const createJustificationSchema = (
  filenames: JustificationFilenames,
  shape: AnswerShape,
) => {
  const hasPdf = filenames.some((file) => file.kind === "pdf-bates");
  const hasDocx = filenames.some((file) => file.kind === "docx-folio");

  const filenamesList = filenames
    .map((filename) => {
      if (filename.kind === "pdf-bates") {
        return `- ${filename.simplified} (PDF — cite Bates stamps from the page corners, e.g. ${filename.simplified}-0002)`;
      }
      return `- ${filename.simplified} (DOCX — cite folio blockIds from the JSON list, e.g. seq-0010)`;
    })
    .join("\n");
  const hasCitableFiles = filenames.length > 0;

  const citationGuide: string[] = [];
  if (hasPdf) {
    citationGuide.push(
      "PDF files: each citation is the full Bates stamp shown on " +
        "the page (e.g., F0-0002).",
    );
  }
  if (hasDocx) {
    citationGuide.push(
      "DOCX files: each citation is a folio blockId taken verbatim " +
        'from that file\'s JSON block list (e.g., "seq-0010").',
    );
  }
  if (hasPdf && hasDocx) {
    citationGuide.push(
      "Match the citation format to the source file's type — never " +
        "mix Bates stamps with blockIds inside one statement.",
    );
  }

  const exampleFile = filenames[0];
  const exampleCitation =
    exampleFile?.kind === "docx-folio"
      ? "seq-0010"
      : `${exampleFile?.simplified ?? "F0"}-0002`;

  // Schema is converted to JSON Schema for TanStack tools with
  // `@valibot/to-json-schema`. That
  // converter rejects transformation actions like `v.trim()` —
  // they have no JSON Schema equivalent — so we keep validation
  // here strictly to constraints (`v.minLength`, `v.nonEmpty`).
  // Stripping incidental whitespace, if needed, is a parse-side
  // concern handled in `normalizeJustification`.
  const items = v.array(
    v.strictObject({
      file: v.string(),
      statements: v.array(
        v.strictObject({
          text: v.pipe(v.string(), v.minLength(1)),
          citations: v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1))),
            v.nonEmpty(),
          ),
        }),
      ),
    }),
  );
  const constrainedItems = hasCitableFiles
    ? items
    : v.pipe(items, v.maxLength(0));

  return v.pipe(
    constrainedItems,
    v.description(
      [
        hasCitableFiles
          ? "Generate structured justifications that reference the file " +
            "context you received."
          : "Return an empty justification array. The supplied " +
            "extracted-text sources have no supported citation locator.",
        hasCitableFiles
          ? 'Create one array item per cited source file with "file" equal ' +
            "to the exact filename attached with the file in the message."
          : "Do not invent a filename or citation for an extracted-text " +
            "source.",
        `Citable filenames:\n${filenamesList || "- none"}`,
        ...(hasCitableFiles
          ? [
              'For each statement, write concise supporting text in "text" ' +
                'and the matching citations in "citations".',
            ]
          : []),
        ...citationGuide,
        ...citationInstructions(shape),
        "Do not include markup, HTML, Markdown, or narrative outside " +
          "the object.",
        `Example: ${JSON.stringify(
          hasCitableFiles
            ? [
                {
                  file: exampleFile?.simplified ?? "F0",
                  statements: [
                    {
                      text: "The document identifies the contracting party.",
                      citations: [exampleCitation],
                    },
                  ],
                },
              ]
            : [],
        )}`,
      ].join("\n\n"),
    ),
  ) satisfies v.GenericSchema<AIJustificationOutput>;
};

export const buildBatchSchema = (
  properties: readonly AIBatchProperty[],
  filenames: JustificationFilenames,
) => {
  const schemaShape: Record<
    string,
    v.GenericSchema<{ answer: Answer; justification: AIJustificationOutput }>
  > = {};

  for (const property of properties) {
    // Null only for a select with no options: there is nothing to choose from,
    // so the column is left out of the batch rather than asked unanswerably.
    const answer = answerSchemaForShape(property.content, property.answerShape);
    if (answer === null) {
      continue;
    }
    schemaShape[property.id] = v.strictObject({
      answer,
      justification: createJustificationSchema(filenames, property.answerShape),
    });
  }

  return v.strictObject(schemaShape);
};

// --------------- User message templates ---------------

type DocxBlocksMessageProps = {
  simplifiedName: string;
  blocks: readonly FolioAIBlock[];
};

const DOCX_PROMPT_BLOCK_KEPT_CHARS =
  DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS - PROMPT_TRUNCATION_MARKER.length;

const truncateBlockText = (text: string): string => {
  if (text.length <= DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, DOCX_PROMPT_BLOCK_KEPT_CHARS)}${PROMPT_TRUNCATION_MARKER}`;
};

export const buildDocxBlocksMessage = ({
  simplifiedName,
  blocks,
}: DocxBlocksMessageProps): string => {
  const cut = blocks.filter(
    (block) => block.text.length > DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS,
  );
  recordPromptInputTruncation({
    input: "docx_blocks",
    truncatedParts: cut.length,
    droppedChars: cut.reduce(
      (total, block) =>
        total + block.text.length - DOCX_PROMPT_BLOCK_KEPT_CHARS,
      0,
    ),
    maxChars: DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS,
  });
  const promptBlocks = blocks.map((block) => {
    const out: {
      blockId: string;
      kind: typeof block.kind;
      text: string;
      label?: string;
      styleId?: string;
    } = {
      blockId: block.id,
      kind: block.kind,
      text: truncateBlockText(block.text),
    };
    if (block.displayLabel) {
      out.label = block.displayLabel;
    }
    if (block.styleId) {
      out.styleId = block.styleId;
    }
    return out;
  });

  return [
    `DOCX file ${simplifiedName} — folio block list. Cite blocks by ` +
      `their "blockId" in any justification that references this file.`,
    "```json",
    JSON.stringify(promptBlocks),
    "```",
  ].join("\n");
};

export const buildTextInputsMessage = (textInputs: readonly TextInput[]) => {
  const list = textInputs
    .map(({ propertyId, value }) => `- ${propertyId}: ${value}`)
    .join("\n");

  return (
    "The following text inputs were provided " +
    `(keyed by propertyId):\n${list}`
  );
};

export const buildPromptsMessage = (
  properties: readonly {
    id: string;
    tool: { prompt: string };
  }[],
) => {
  const list = properties
    .map(({ id, tool }) => `- ${id}: ${tool.prompt}`)
    .join("\n");

  return (
    "Analyze the attached documents and text inputs, " +
    "then answer the following prompts " +
    `(keyed by propertyId):\n${list}`
  );
};
