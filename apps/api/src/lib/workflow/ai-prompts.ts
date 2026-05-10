import * as v from "valibot";

import type { FolioAIBlock } from "@stll/folio/server";

import { DOCX_REVIEW_MARKUP_EXAMPLES } from "@/api/lib/docx-review-markup";
import { Unreachable } from "@/api/lib/errors/tagged-errors";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
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

const ACTIVE_DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS = 1500;

// --------------- Schema context ---------------

const context = {
  text: {
    description:
      "Answer for property. Keep it plain text, keep it " +
      "short and concise, less than 100 characters",
    examples: ["Contract for sale of goods"],
  },
  singleSelect: {
    description:
      "Answer for property. Select exactly one option or " +
      "null if none applicable",
    examples: [null],
  },
  multiSelect: {
    description:
      "Answer for property. Select one or more options, " +
      "or null if none applicable",
    examples: [null],
  },
  date: {
    description:
      "Answer in ISO YYYY-MM-DD format, " +
      "or null if no date is found in the document.",
    examples: ["2024-03-15", null],
  },
  int: {
    amount: {
      description: "The integer amount extracted from the document",
      examples: [1500],
    },
    currency: {
      description:
        "ISO 4217 currency code if the value represents money, " +
        "otherwise null",
      examples: ["USD", "EUR", "CZK"],
    },
  },
};

// --------------- Schema builders ---------------

export type Answer =
  | string
  | string[]
  | null
  | { amount: number; currency: string | null };

const createJustificationSchema = (filenames: JustificationFilenames) => {
  const hasPdf = filenames.some((file) => file.kind === "pdf-bates");
  const hasDocx = filenames.some((file) => file.kind === "docx-folio");

  const filenamesList = filenames
    .map((filename) => {
      if (filename.kind === "pdf-bates") {
        return `- ${filename.simplified} (PDF — cite Bates stamps from the page corners, e.g. ${filename.simplified}-0002)`;
      }
      return `- ${filename.simplified} (DOCX — cite folio blockIds from the JSON list, e.g. b-0010)`;
    })
    .join("\n");

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
        'from that file\'s JSON block list (e.g., "b-0010").',
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
      ? "b-0010"
      : `${exampleFile?.simplified ?? "F0"}-0002`;

  // Schema is converted to JSON Schema by the Vercel AI SDK
  // (`valibotSchema(...)` → `@valibot/to-json-schema`). That
  // converter rejects transformation actions like `v.trim()` —
  // they have no JSON Schema equivalent — so we keep validation
  // here strictly to constraints (`v.minLength`, `v.nonEmpty`).
  // Stripping incidental whitespace, if needed, is a parse-side
  // concern handled in `normalizeJustification`.
  return v.pipe(
    v.array(
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
    ),
    v.description(
      [
        "Generate structured justifications that reference the file " +
          "context you received.",
        'Create one array item per source file with "file" equal to ' +
          "the exact filename attached with the file in the message.",
        `Filenames:\n${filenamesList}`,
        'For each statement, write concise supporting text in "text" ' +
          'and the matching citations in "citations".',
        ...citationGuide,
        "Do not include markup, HTML, Markdown, or narrative outside " +
          "the object.",
        `Example: ${JSON.stringify([
          {
            file: exampleFile?.simplified ?? "F0",
            statements: [
              {
                text: "The document identifies the contracting party.",
                citations: [exampleCitation],
              },
            ],
          },
        ])}`,
      ].join("\n\n"),
    ),
  ) satisfies v.GenericSchema<AIJustificationOutput>;
};

export const buildBatchSchema = (
  properties: BatchProperty[],
  filenames: JustificationFilenames,
) => {
  const justificationSchema = createJustificationSchema(filenames);

  const schemaShape: Record<
    string,
    v.GenericSchema<{ answer: Answer; justification: AIJustificationOutput }>
  > = {};

  for (const property of properties) {
    const content = property.content;

    switch (content.type) {
      case "text": {
        schemaShape[property.id] = v.strictObject({
          answer: v.pipe(
            v.string(),
            v.description(context.text.description),
            v.examples(context.text.examples),
          ),
          justification: justificationSchema,
        });
        break;
      }
      case "single-select": {
        const options = content.options.map((opt) => opt.value);
        if (options.length > 0) {
          schemaShape[property.id] = v.strictObject({
            answer: v.pipe(
              v.fallback(v.nullable(v.picklist(options)), null),
              v.description(context.singleSelect.description),
              v.examples(context.singleSelect.examples),
            ),
            justification: justificationSchema,
          });
        }
        break;
      }
      case "multi-select": {
        const options = content.options.map((opt) => opt.value);
        if (options.length > 0) {
          schemaShape[property.id] = v.strictObject({
            answer: v.pipe(
              v.fallback(
                v.nullable(v.pipe(v.array(v.picklist(options)), v.nonEmpty())),
                null,
              ),
              v.description(context.multiSelect.description),
              v.examples(context.multiSelect.examples),
            ),
            justification: justificationSchema,
          });
        }
        break;
      }
      case "date": {
        schemaShape[property.id] = v.strictObject({
          answer: v.pipe(
            v.nullable(v.pipe(v.string(), v.isoDate())),
            v.description(context.date.description),
            v.examples(context.date.examples),
          ),
          justification: justificationSchema,
        });
        break;
      }
      case "int": {
        schemaShape[property.id] = v.strictObject({
          answer: v.strictObject({
            amount: v.pipe(
              v.number(),
              v.integer(),
              v.description(context.int.amount.description),
              v.examples(context.int.amount.examples),
            ),
            currency: v.pipe(
              v.nullable(v.string()),
              v.description(context.int.currency.description),
              v.examples(context.int.currency.examples),
            ),
          }),
          justification: justificationSchema,
        });
        break;
      }
      default:
        throw new Unreachable({
          message: "Property type not matched",
        });
    }
  }

  return v.strictObject(schemaShape);
};

// --------------- User message templates ---------------

type DocxBlocksMessageProps = {
  simplifiedName: string;
  blocks: readonly FolioAIBlock[];
};

const truncateBlockText = (text: string): string => {
  if (text.length <= ACTIVE_DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, ACTIVE_DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS - 1)}…`;
};

export const buildDocxBlocksMessage = ({
  simplifiedName,
  blocks,
}: DocxBlocksMessageProps): string => {
  const promptBlocks = blocks.map((block) => {
    const out: {
      blockId: string;
      kind: typeof block.kind;
      text: string;
      label?: string;
    } = {
      blockId: block.id,
      kind: block.kind,
      text: truncateBlockText(block.text),
    };
    if (block.displayLabel) {
      out.label = block.displayLabel;
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
