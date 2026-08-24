import { describe, expect, test } from "bun:test";

import { proposedTopicsSchema } from "@/api/handlers/document-reviews/reference-topics";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

describe("proposedTopicsSchema", () => {
  // The schema is handed to the provider as JSON Schema; a valibot action
  // with no JSON Schema form (trim, transform) only fails at request time.
  test("converts to provider JSON Schema", () => {
    const schema = toTanStackValibotSchema(proposedTopicsSchema);
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(json).toMatchObject({ type: "object" });
  });
});
