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
import type { StructuredOutputTarget } from "@/api/lib/structured-output-budget";
import { structuredOutputWireJsonSchema } from "@/api/lib/tanstack-ai-generate";
import { buildBatchSchema } from "@/api/lib/workflow/ai-prompts";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";

// A ceiling, not the expected chunk size: six is the largest batch Anthropic
// was ever measured to compile, so a chunk above it would be one the provider
// has already rejected. How many properties actually fit depends on the schema
// each one projects to (four, for the shape `buildBatchSchema` emits today),
// which is why the budget itself is stated in bytes rather than a count.
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

// The batch length is drawn uniformly over the whole workspace range first:
// fast-check's default array sizing would keep every generated batch far
// below the workspace maximum, and the sizes that matter here are the ones a
// real workspace reaches.
const propertiesArbitrary = fc
  .integer({ min: 1, max: PROPERTIES_PER_WORKSPACE_MAX })
  .chain((length) =>
    fc.array(fc.constantFrom(...CONTENT_KINDS), {
      minLength: length,
      maxLength: length,
      size: "max",
    }),
  )
  .map((kinds) => kinds.map(propertyForKind));

// One citable PDF source, so the batch carries the fuller justification
// schema a real extraction sends rather than the empty-citation variant.
const FILENAMES: JustificationFilenames = [
  {
    kind: "pdf-bates",
    original: "services-agreement.pdf",
    simplified: "F0",
    fileFieldId: toSafeId<"field">("file_field_0"),
  },
];

const wireSchemaFor = (
  provider: TanStackAIProvider,
  properties: readonly AIBatchProperty[],
): unknown =>
  structuredOutputWireJsonSchema({
    outputSchema: buildBatchSchema(properties, FILENAMES),
    provider,
  });

/**
 * `compiler` is stated here rather than read back from
 * `resolveStructuredOutputBudget`, so a resolver that ignored an OpenRouter
 * id's upstream prefix fails this property instead of agreeing with it.
 */
type BudgetTarget = StructuredOutputTarget & {
  compiler: TanStackAIProvider;
};

// Every provider once, plus the two OpenRouter ids that proxy to a provider
// with its own budget: the id, not the addressed provider, decides which
// grammar compiler sees the schema.
const TARGETS: readonly BudgetTarget[] = [
  ...TANSTACK_AI_PROVIDERS.map((provider) => ({
    provider,
    modelId: `${provider}-model`,
    compiler: provider,
  })),
  {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-5",
    compiler: "anthropic",
  },
  {
    provider: "openrouter",
    modelId: "openai/gpt-5.6-luna",
    compiler: "openai",
  },
];

describe("splitting a workflow batch for the provider's schema budget", () => {
  test("every chunk fits its provider and the chunks partition the batch in order", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TARGETS),
        propertiesArbitrary,
        ({ provider, modelId, compiler }, properties) => {
          const split = splitPropertiesForBudget({
            provider,
            modelId,
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
                  modelId,
                  schema: wireSchemaFor(provider, chunk),
                }),
              ),
            ).toBe(false);
            if (compiler === "anthropic") {
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
