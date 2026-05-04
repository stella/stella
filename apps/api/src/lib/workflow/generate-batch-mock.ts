import { faker } from "@faker-js/faker";
import { Result } from "better-result";
import { sleep } from "bun";

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

    await sleep(faker.number.int({ min: 1000, max: 3000 }));

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

      switch (content.type) {
        case "text": {
          const value = `${inputFieldValue} + ${faker.lorem.word()}`;
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
          const value = faker.helpers.arrayElement(possibleValues);
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
          const value = faker.helpers.arrayElements(possibleValues, {
            min: 1,
            max: possibleValues.length,
          });
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
          const value =
            faker.date.past().toISOString().split("T")[0] ?? "1970-01-01";
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
          const value = faker.number.int({ min: 0, max: 1_000_000 });
          const currency = faker.helpers.arrayElement(currencies);
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
          text: faker.lorem.sentence(),
          citations: [`${filename.simplified}-0001`],
        },
        {
          text: faker.lorem.sentence(),
          citations: [`${filename.simplified}-0002`],
        },
      ],
    });
  }

  return justifications;
};
