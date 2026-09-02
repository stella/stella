import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";
import { PROPERTIES_PER_WORKSPACE_MAX } from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import type { AiExtractablePropertyContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import {
  checkStructuredOutputBudget,
  splitPropertiesForBudget,
} from "@/api/lib/structured-output-budget";
import { structuredOutputWireJsonSchema } from "@/api/lib/tanstack-ai-generate";
import { buildBatchSchema } from "@/api/lib/workflow/ai-prompts";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";

// Anthropic accepted a 6-property text batch and rejected a 7-property one, so
// no chunk may ever exceed six. See STRUCTURED_OUTPUT_BUDGETS.
const ANTHROPIC_MAX_PROPERTIES_PER_CHUNK = 6;

const OPTION_VALUES = [
  "Delaware",
  "England and Wales",
  "New York",
  "California",
  "Singapore",
] as const;

const CONTENT_KINDS = [
  "text",
  "date",
  "int",
  "single-select",
  "multi-select",
] as const;

type ContentKind = (typeof CONTENT_KINDS)[number];

const contentForKind = (kind: ContentKind): AiExtractablePropertyContent => {
  switch (kind) {
    case "text":
      return { version: 1, type: "text" };
    case "date":
      return { version: 1, type: "date" };
    case "int":
      return { version: 1, type: "int" };
    case "single-select":
    case "multi-select":
      return {
        version: 1,
        type: kind,
        options: OPTION_VALUES.map((value) => ({ color: "blue", value })),
        fallback: null,
      };
    default: {
      const exhaustive: never = kind;
      throw new TypeError(`Unhandled content kind: ${String(exhaustive)}`);
    }
  }
};

const propertyForKind = (
  kind: ContentKind,
  index: number,
): AIBatchProperty => ({
  id: toSafeId<"property">(`property_${index}`),
  status: "stale",
  content: contentForKind(kind),
  dependencies: [],
  tool: {
    version: 1,
    type: "ai-model",
    prompt: `Extract the ${kind} value for field ${index} from the documents.`,
  },
});

// `size: "max"` because fast-check's default array size would keep every
// generated batch far below the workspace maximum, and the sizes that matter
// here are the ones a real workspace reaches.
const propertiesArbitrary = fc
  .array(fc.constantFrom(...CONTENT_KINDS), {
    minLength: 1,
    maxLength: PROPERTIES_PER_WORKSPACE_MAX,
    size: "max",
  })
  .map((kinds) => kinds.map(propertyForKind));

const FILENAMES = [
  { kind: "pdf-bates", simplified: "F0" },
] as const satisfies Parameters<typeof buildBatchSchema>[1];

const wireSchemaFor = (
  provider: TanStackAIProvider,
  properties: readonly AIBatchProperty[],
): unknown =>
  structuredOutputWireJsonSchema({
    outputSchema: buildBatchSchema(properties, FILENAMES),
    provider,
  });

describe("splitting a workflow batch for the provider's schema budget", () => {
  test("every chunk fits its provider and the chunks partition the batch in order", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TANSTACK_AI_PROVIDERS),
        propertiesArbitrary,
        (provider, properties) => {
          const split = splitPropertiesForBudget({
            provider,
            properties,
            buildSchema: (chunk) => wireSchemaFor(provider, chunk),
          });
          if (Result.isError(split)) {
            throw split.error;
          }

          // Partition, in order: concatenating the chunks reproduces the batch.
          expect(split.value.flat()).toEqual(properties);
          expect(split.value.every((chunk) => chunk.length > 0)).toBe(true);

          for (const chunk of split.value) {
            expect(
              Result.isError(
                checkStructuredOutputBudget({
                  provider,
                  schema: wireSchemaFor(provider, chunk),
                }),
              ),
            ).toBe(false);
            if (provider === "anthropic") {
              expect(chunk.length).toBeLessThanOrEqual(
                ANTHROPIC_MAX_PROPERTIES_PER_CHUNK,
              );
            }
          }
        },
      ),
      propertyConfig({ numRuns: 30 }),
    );
  });
});
