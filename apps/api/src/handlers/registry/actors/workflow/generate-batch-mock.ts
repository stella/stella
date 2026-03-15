import { faker } from "@faker-js/faker";
import { matchError, Result } from "better-result";
import { sleep } from "bun";
import { nanoid } from "nanoid";

import {
  fetchInputFieldsForBatch,
  prepareBatchInput,
} from "@/api/handlers/registry/actors/workflow/generate-batch-shared";
import type {
  AIJustification,
  AIResult,
  FieldContentForAI,
  GenerateBatchProps,
  GenerateBatchResult,
} from "@/api/handlers/registry/actors/workflow/generate-batch-shared";
import { parseJustificationXml } from "@/api/handlers/registry/actors/workflow/parse-justifications";
import type { JustificationFilenames } from "@/api/handlers/registry/actors/workflow/parse-justifications";
import {
  Unreachable,
  WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";

const getValueFromInputFields = (input: FieldContentForAI[]): string => {
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
  scopedDb,
}: GenerateBatchProps): Promise<GenerateBatchResult> =>
  await Result.gen(async function* generateBatchMockGen() {
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
        original: file.fileId,
        simplified: `f${index}`,
        fileFieldId: file.fileFieldId,
      }),
    );

    await sleep(faker.number.int({ min: 1000, max: 3000 }));

    for (const property of inputProperties) {
      const content = property.content;
      const fieldId = nanoid();

      const justificationXml = createMockJustifications(filenames);
      const justification = yield* parseJustificationXml({
        xml: justificationXml,
        filenames,
      });

      if (justification) {
        const justificationId = nanoid();
        aiJustifications.push({
          fieldId,
          justificationId,
          ...justification,
        });
      }

      switch (content.type) {
        case "text": {
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "text",
              version: 1,
              value: `${inputFieldValue} + ${faker.lorem.word()}`,
            },
          });
          break;
        }

        case "single-select": {
          const possibleValues = content.options.map((option) => option.value);
          const value = faker.helpers.arrayElement(possibleValues);
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
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "date",
              version: 1,
              value:
                faker.date.past().toISOString().split("T")[0] ?? "1970-01-01",
            },
          });
          break;
        }

        case "int": {
          const currencies = ["USD", "EUR", "CZK", null];
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "int",
              version: 1,
              value: faker.number.int({ min: 0, max: 1_000_000 }),
              currency: faker.helpers.arrayElement(currencies),
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
  }).then((result) =>
    result.mapError((err) =>
      matchError(err, {
        ParseXmlError: (parseErr) =>
          new WorkflowIntegrationError({
            message: parseErr.message,
            cause: parseErr,
          }),
        WorkflowValidationError: (validErr) => validErr,
      }),
    ),
  );

export const createMockJustifications = (filenames: JustificationFilenames) => {
  const xmlParts: string[] = [];

  for (const filename of filenames) {
    xmlParts.push(
      `<j f="${filename.simplified}">${faker.lorem.sentence()} <p-${filename.simplified}-0001 /> ${faker.lorem.sentence()} <p-${filename.simplified}-0002 /></j>`,
    );
  }

  return xmlParts.join("\n");
};
