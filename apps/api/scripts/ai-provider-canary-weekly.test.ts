import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";

import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";

import {
  CANARY_PROVIDERS,
  WEEKLY_TOOL_SHAPES,
} from "./ai-provider-canary-config";
import { createWeeklyToolShapeDefinition } from "./ai-provider-canary-weekly";

const isAcceptedWeeklyInput = (
  expectedInputs: unknown[],
  observedInput: unknown,
): boolean =>
  expectedInputs.some((expectedInput) =>
    isDeepStrictEqual(expectedInput, observedInput),
  );

describe("AI provider weekly tool shapes", () => {
  test("projects every rotating shape for every canary provider", () => {
    const toolNames = new Set<string>();

    for (const shape of WEEKLY_TOOL_SHAPES) {
      for (const provider of CANARY_PROVIDERS) {
        const { tool } = createWeeklyToolShapeDefinition(shape, provider, []);
        toolNames.add(tool.name);

        const projected = projectSchemaInputJsonSchema(
          tool.inputSchema,
          providerSafeJsonSchemaOptionsForTanStackProvider(provider),
        );
        const jsonSchema = convertSchemaToJsonSchema(projected);

        expect(jsonSchema?.type).toBe("object");
        expect(jsonSchema?.additionalProperties).toBe(false);
        expect(JSON.stringify(jsonSchema)).not.toMatch(
          /"(?:const|oneOf|propertyNames|\$defs)":/u,
        );
      }
    }

    expect(toolNames.size).toBe(WEEKLY_TOOL_SHAPES.length);
  });
});

describe("AI provider weekly null-widening duality", () => {
  test("non-null-widening providers still require omission on both affected shapes", () => {
    const nested = createWeeklyToolShapeDefinition(
      "nested-optional",
      "openrouter",
      [],
    );
    expect(nested.prompt).toContain("Omit details.optionalNote.");
    expect(
      isAcceptedWeeklyInput(nested.expectedInputs, {
        details: { value: "stella-weekly" },
        type: "nested",
      }),
    ).toBe(true);
    expect(
      isAcceptedWeeklyInput(nested.expectedInputs, {
        details: { optionalNote: null, value: "stella-weekly" },
        type: "nested",
      }),
    ).toBe(false);

    const arrayItem = createWeeklyToolShapeDefinition(
      "array-item-optional",
      "openrouter",
      [],
    );
    expect(arrayItem.prompt).toContain("Omit items[0].optionalLabel.");
    expect(
      isAcceptedWeeklyInput(arrayItem.expectedInputs, {
        items: [{ id: "item-1" }],
        type: "array",
      }),
    ).toBe(true);
    expect(
      isAcceptedWeeklyInput(arrayItem.expectedInputs, {
        items: [{ id: "item-1", optionalLabel: null }],
        type: "array",
      }),
    ).toBe(false);
  });

  test("null-widening providers accept omission or a synthetic null, but not a hallucinated literal", () => {
    for (const provider of ["openai", "mistral"] as const) {
      const nested = createWeeklyToolShapeDefinition(
        "nested-optional",
        provider,
        [],
      );
      expect(nested.prompt).toContain("Set details.optionalNote to null.");
      expect(
        isAcceptedWeeklyInput(nested.expectedInputs, {
          details: { value: "stella-weekly" },
          type: "nested",
        }),
      ).toBe(true);
      expect(
        isAcceptedWeeklyInput(nested.expectedInputs, {
          details: { optionalNote: null, value: "stella-weekly" },
          type: "nested",
        }),
      ).toBe(true);
      expect(
        isAcceptedWeeklyInput(nested.expectedInputs, {
          details: { optionalNote: "unexpected", value: "stella-weekly" },
          type: "nested",
        }),
      ).toBe(false);

      const arrayItem = createWeeklyToolShapeDefinition(
        "array-item-optional",
        provider,
        [],
      );
      expect(arrayItem.prompt).toContain("Set items[0].optionalLabel to null.");
      expect(
        isAcceptedWeeklyInput(arrayItem.expectedInputs, {
          items: [{ id: "item-1" }],
          type: "array",
        }),
      ).toBe(true);
      expect(
        isAcceptedWeeklyInput(arrayItem.expectedInputs, {
          items: [{ id: "item-1", optionalLabel: null }],
          type: "array",
        }),
      ).toBe(true);
      expect(
        isAcceptedWeeklyInput(arrayItem.expectedInputs, {
          items: [{ id: "item-1", optionalLabel: "unexpected" }],
          type: "array",
        }),
      ).toBe(false);
    }
  });
});
