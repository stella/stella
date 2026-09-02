import { describe, expect, test } from "bun:test";

import { propertyKindsForTool } from "@/api/lib/properties/property-kinds";

// PropertyTool (apps/api/src/db/schema-validators.ts) is a union of three
// TypeBox object schemas, not a const array of tool types, so there is no
// `keyof typeof` or mapped-array source to derive this list from. Each case
// below is asserted explicitly instead; a fourth tool type added to the
// union will fail the helper's `never` exhaustiveness check at compile time,
// not here.
describe("propertyKindsForTool", () => {
  test("ai-model is restricted to documents: extraction only ever runs over documents", () => {
    expect(propertyKindsForTool({ type: "ai-model" })).toEqual(["document"]);
  });

  test("playbook-verdict is restricted to documents: it grades an ai-model ASK value", () => {
    expect(propertyKindsForTool({ type: "playbook-verdict" })).toEqual([
      "document",
    ]);
  });

  test("manual-input applies to every kind", () => {
    expect(propertyKindsForTool({ type: "manual-input" })).toBeNull();
  });
});
