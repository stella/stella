import { describe, expect, test } from "bun:test";

import { bboxOutputSchema } from "@/api/lib/bbox/ai-prompts";
import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import type { ValueConstraintStrategy } from "@/api/lib/provider-safe-json-schema";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

// The provider only ever compiles the `structured-output` projection,
// which omits value constraints; anything the schema expresses with
// one is enforced nowhere but the local parse of a finished response.
const projectBBoxSchema = (valueConstraintStrategy: ValueConstraintStrategy) =>
  toTanStackValibotSchema(bboxOutputSchema, {
    ...providerSafeJsonSchemaOptionsForTanStackProvider(
      "openrouter",
      "structured-output",
    ),
    valueConstraintStrategy,
  })["~standard"].jsonSchema.output({ target: "draft-2020-12" });

describe("bboxOutputSchema", () => {
  test("states its contract in keywords the projection keeps", () => {
    expect(projectBBoxSchema("omit")).toEqual(projectBBoxSchema("preserve"));
  });

  test("compiles to a fully required coordinate object", () => {
    expect(projectBBoxSchema("omit")).toEqual({
      type: "object",
      properties: {
        boxes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              yMin: { type: "number" },
              xMin: { type: "number" },
              yMax: { type: "number" },
              xMax: { type: "number" },
            },
            required: ["yMin", "xMin", "yMax", "xMax"],
            additionalProperties: false,
            description:
              "Bounding box normalized to a 0-1000 scale, with yMin/xMin " +
              "the top-left corner and yMax/xMax the bottom-right",
          },
          description: "Array of bounding boxes",
        },
      },
      required: ["boxes"],
      additionalProperties: false,
    });
  });
});
