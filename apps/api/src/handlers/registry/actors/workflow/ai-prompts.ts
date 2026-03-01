import * as v from "valibot";

import type { TextInput } from "@/api/handlers/registry/actors/workflow/generate-batch-shared";
import type { BatchProperty } from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import type { JustificationFilenames } from "@/api/handlers/registry/actors/workflow/parse-justifications";
import { Unreachable } from "@/api/lib/errors/tagged-errors";

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

export const createJustificationSchema = (
  filenames: JustificationFilenames,
) => {
  const filenamesList = filenames
    .map((filename) => `- ${filename.simplified}`)
    .join("\n");

  return v.pipe(
    v.string(),
    v.description(
      [
        "Generate XML justifications that reference the file " +
          "context you received.",
        "Create one <j> element per filename with the " +
          '"f" attribute equal to the filename, using that ' +
          "exact filename attached with the file in the message.",
        `Filenames:\n${filenamesList}`,
        "Inside each justification, write concise supporting " +
          "text and immediately follow every evidence statement " +
          "with a citation tag in the format " +
          "<p-BATES_NUMBER /> where BATES_NUMBER is the full " +
          "Bates stamp (e.g., F0-0002).",
        "Citation tags must be self-closing, match the exact " +
          "casing shown, and appear inline with the " +
          "justification sentence they support.",
        `Example: <j f="${filenames[0]?.simplified ?? "F0"}">` +
          "This is a justification " +
          `<p-${filenames[0]?.simplified ?? "F0"}-0002 /> ` +
          "This is another justification " +
          `<p-${filenames[0]?.simplified ?? "F0"}-0003 /></j>.`,
        "Return only well-formed XML composed of the " +
          "justification elements described above; do not " +
          "include any other narrative or formatting outside " +
          "the XML.",
      ].join("\n\n"),
    ),
  );
};

export const buildBatchSchema = (
  properties: BatchProperty[],
  filenames: JustificationFilenames,
) => {
  const justificationSchema = createJustificationSchema(filenames);

  const schemaShape: Record<
    string,
    v.GenericSchema<{ answer: Answer; justification: string }>
  > = {};

  for (const property of properties) {
    const content = property.content;

    switch (content.type) {
      case "text": {
        schemaShape[property.id] = v.object({
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
          schemaShape[property.id] = v.object({
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
          schemaShape[property.id] = v.object({
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
        schemaShape[property.id] = v.object({
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
        schemaShape[property.id] = v.object({
          answer: v.object({
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

  return v.object(schemaShape);
};

// --------------- User message templates ---------------

export const buildTextInputsMessage = (textInputs: TextInput[]) => {
  const list = textInputs
    .map(({ propertyId, value }) => `- ${propertyId}: ${value}`)
    .join("\n");

  return (
    "The following text inputs were provided " +
    `(keyed by propertyId):\n${list}`
  );
};

export const buildPromptsMessage = (
  properties: Array<{
    id: string;
    tool: { prompt: string };
  }>,
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
