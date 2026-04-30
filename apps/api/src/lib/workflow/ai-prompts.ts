import * as v from "valibot";

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
  "for each propertyId. Reference pages using the Bates numbers " +
  "shown in all four corners of each page " +
  "(format: F0-0001, F1-0001, etc.).";

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
  const filenamesList = filenames
    .map((filename) => `- ${filename.simplified}`)
    .join("\n");

  return v.pipe(
    v.array(
      v.strictObject({
        file: v.string(),
        statements: v.array(
          v.strictObject({
            text: v.pipe(v.string(), v.trim(), v.minLength(1)),
            citations: v.pipe(
              v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
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
        "For each statement, write concise supporting text in " +
          '"text" and put the Bates stamps that support it in ' +
          '"citations".',
        "Citations must be full Bates stamps exactly as shown on " +
          "the page, for example F0-0002. Do not include markup, " +
          "HTML, Markdown, or narrative outside the object.",
        `Example: ${JSON.stringify([
          {
            file: filenames[0]?.simplified ?? "F0",
            statements: [
              {
                text: "The document identifies the contracting party.",
                citations: [`${filenames[0]?.simplified ?? "F0"}-0002`],
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
