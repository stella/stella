import { toJsonSchema } from "@valibot/to-json-schema";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { stripInternalMetadata } from "@/api/lib/json-schema/valibot-json-schema-config";

describe("stripInternalMetadata", () => {
  test("keeps JSON Schema annotations and drops every other metadata key", () => {
    const schema = v.object({
      id: v.pipe(
        v.string(),
        v.metadata({
          title: "Identifier",
          description: "The row id.",
          examples: ["a1"],
          internal: { role: "passthroughId" },
        }),
      ),
    });

    expect(
      toJsonSchema(schema, { overrideAction: stripInternalMetadata }),
    ).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        id: {
          type: "string",
          title: "Identifier",
          description: "The row id.",
          examples: ["a1"],
        },
      },
      required: ["id"],
    });
  });
});
