import { panic, Result } from "better-result";
import { sleep } from "bun";

import { Temporal } from "@stll/time";

import { createSafeId } from "@/api/lib/branded-types";
import { Unreachable } from "@/api/lib/errors/tagged-errors";
import {
  fetchInputFieldsForBatch,
  prepareBatchInput,
} from "@/api/lib/workflow/generate-batch-shared";
import type {
  AIJustification,
  AIResult,
  FieldContentForAI,
  GenerateBatchProps,
  GenerateBatchResult,
} from "@/api/lib/workflow/generate-batch-shared";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";

const MOCK_WORDS = [
  "review",
  "document",
  "record",
  "client",
  "agreement",
] as const;

type RandomIntegerOptions = { min: number; max: number };

const randomInteger = ({ min, max }: RandomIntegerOptions): number =>
  min + Math.floor(Math.random() * (max - min + 1));

const randomElement = <T>(values: readonly T[]): T => {
  const value = values.at(randomInteger({ min: 0, max: values.length - 1 }));
  if (value === undefined) {
    return panic("mock sampling requires a non-empty array");
  }
  return value;
};

const randomElements = <T>(values: readonly T[]): T[] => {
  if (values.length === 0) {
    return [];
  }
  const remaining = [...values];
  const selected: T[] = [];
  const count = randomInteger({ min: 1, max: remaining.length });
  for (let index = 0; index < count; index += 1) {
    const position = randomInteger({ min: 0, max: remaining.length - 1 });
    selected.push(randomElement(remaining.splice(position, 1)));
  }
  return selected;
};

const randomSentence = (): string =>
  `${Array.from({ length: 6 }, () => randomElement(MOCK_WORDS)).join(" ")}.`;

const getValueFromInputFields = (
  input: readonly FieldContentForAI[],
): string => {
  const values = input.map((field) => {
    switch (field.type) {
      case "file":
        return "file";
      case "text":
        return field.value;
      case "single-select":
        return field.value;
      case "multi-select":
        return field.value.join(", ");
      case "date":
        return field.value;
      case "int":
        return field.currency
          ? `${field.value} ${field.currency}`
          : String(field.value);
      case "money":
        return `${field.amountCents} ${field.currency}`;
      case "person":
        return field.name;
      default:
        throw new Unreachable({
          message: "Field type not matched",
        });
    }
  });

  return values.join(" + ");
};

export const generateBatchMock = async ({
  batch,
  entityVersionId,
  onPartialAnswer,
  scopedDb,
}: GenerateBatchProps): Promise<GenerateBatchResult> =>
  await Result.gen(async function* () {
    const inputFields = await fetchInputFieldsForBatch({
      entityVersionId,
      inputPropertyIds: batch.inputs,
      scopedDb,
    });
    const {
      inputProperties,
      inputFieldsForAI,
      resolvedFiles,
      skippedPropertyIds,
    } = yield* prepareBatchInput(inputFields, batch);

    // All properties were skipped due to conditions
    if (inputProperties.length === 0) {
      return Result.ok({
        aiResults: [],
        aiJustifications: [],
        skippedPropertyIds,
        unsupportedPropertyIds: [],
      });
    }

    const inputFieldValue = getValueFromInputFields(inputFieldsForAI);
    const aiResults: AIResult[] = [];
    const aiJustifications: AIJustification[] = [];

    const filenames: JustificationFilenames = resolvedFiles.map(
      (file, index) => ({
        kind: "pdf-bates" as const,
        original: file.fileId,
        simplified: `F${index}`,
        fileFieldId: file.fileFieldId,
      }),
    );

    await sleep(randomInteger({ min: 1000, max: 3000 }));

    for (const property of inputProperties) {
      const content = property.content;
      const fieldId = createSafeId<"field">();

      const justification = yield* normalizeJustification({
        justification: createMockJustifications(filenames),
        filenames,
      });

      if (justification) {
        const justificationId = createSafeId<"justification">();
        aiJustifications.push({
          fieldId,
          justificationId,
          ...justification,
        });
      }

      // The mock only answers what the execution plan schedules, and money,
      // person, and file properties are never scheduled.
      switch (content.type) {
        case "text": {
          const value = `${inputFieldValue} + ${randomElement(MOCK_WORDS)}`;
          await onPartialAnswer?.({ propertyId: property.id, answer: value });
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "text",
              version: 1,
              value,
            },
          });
          break;
        }

        case "single-select": {
          const possibleValues = content.options.map((option) => option.value);
          const value = randomElement(possibleValues);
          await onPartialAnswer?.({ propertyId: property.id, answer: value });
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "single-select",
              version: 1,
              value,
            },
          });
          break;
        }

        case "multi-select": {
          const possibleValues = content.options.map((option) => option.value);
          const value = randomElements(possibleValues);
          await onPartialAnswer?.({
            propertyId: property.id,
            answer: value.join(", "),
          });

          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "multi-select",
              version: 1,
              value,
            },
          });
          break;
        }

        case "date": {
          const value = Temporal.Now.plainDateISO()
            .subtract({ days: randomInteger({ min: 1, max: 365 }) })
            .toString();
          await onPartialAnswer?.({ propertyId: property.id, answer: value });
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "date",
              version: 1,
              value,
            },
          });
          break;
        }

        case "int": {
          const currencies = ["USD", "EUR", "CZK", null];
          const value = randomInteger({ min: 0, max: 1_000_000 });
          const currency = randomElement(currencies);
          await onPartialAnswer?.({
            propertyId: property.id,
            answer: currency ? `${value} ${currency}` : String(value),
          });
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "int",
              version: 1,
              value,
              currency,
            },
          });
          break;
        }
        default:
          throw new Unreachable({
            message: "Property content wasn't matched",
          });
      }
    }

    return Result.ok({
      aiResults,
      aiJustifications,
      skippedPropertyIds,
      unsupportedPropertyIds: [],
    });
  });

export const createMockJustifications = (
  filenames: JustificationFilenames,
): AIJustificationOutput => {
  const justifications: AIJustificationOutput = [];

  for (const filename of filenames) {
    justifications.push({
      file: filename.simplified,
      statements: [
        {
          text: randomSentence(),
          citations: [`${filename.simplified}-0001`],
        },
        {
          text: randomSentence(),
          citations: [`${filename.simplified}-0002`],
        },
      ],
    });
  }

  return justifications;
};
