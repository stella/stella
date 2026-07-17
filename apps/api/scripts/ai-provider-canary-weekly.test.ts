import { describe, expect, test } from "bun:test";

import { convertSchemaToJsonSchema } from "@tanstack/ai";

import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";

import {
  CANARY_PROVIDERS,
  WEEKLY_TOOL_SHAPES,
} from "./ai-provider-canary-config";
import { createWeeklyToolShapeDefinition } from "./ai-provider-canary-weekly";

describe("AI provider weekly tool shapes", () => {
  test("projects every rotating shape for every canary provider", () => {
    const toolNames = new Set<string>();

    for (const shape of WEEKLY_TOOL_SHAPES) {
      const { tool } = createWeeklyToolShapeDefinition(shape, []);
      toolNames.add(tool.name);

      for (const provider of CANARY_PROVIDERS) {
        const projected = projectSchemaInputJsonSchema(
          tool.inputSchema,
          providerSafeJsonSchemaOptionsForTanStackProvider(provider),
        );
        const jsonSchema = convertSchemaToJsonSchema(projected);

        expect(jsonSchema?.type).toBe("object");
        expect(jsonSchema?.additionalProperties).toBe(false);
        expect(JSON.stringify(jsonSchema)).not.toMatch(
          /"(?:const|oneOf|propertyNames|\$defs)":/,
        );
      }
    }

    expect(toolNames.size).toBe(WEEKLY_TOOL_SHAPES.length);
  });
});
