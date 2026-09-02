import { describe, expect, test } from "bun:test";

import {
  propertyKindsForTool,
  propertyKindsForUpdate,
} from "@/api/lib/properties/property-kinds";

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

describe("propertyKindsForUpdate", () => {
  const manual = { version: 1, type: "manual-input" } as const;

  test("a manual property keeps its stored scope across a manual update", () => {
    expect(
      propertyKindsForUpdate({
        previous: { tool: manual, kinds: ["document"] },
        next: manual,
      }),
    ).toEqual(["document"]);
  });

  test("an unscoped manual property stays unscoped", () => {
    expect(
      propertyKindsForUpdate({
        previous: { tool: manual, kinds: null },
        next: manual,
      }),
    ).toBeNull();
  });

  test("switching a manual property to an AI tool narrows it to documents", () => {
    expect(
      propertyKindsForUpdate({
        previous: { tool: manual, kinds: null },
        next: { type: "ai-model" },
      }),
    ).toEqual(["document"]);
  });

  test("switching an AI property to manual input re-derives an open scope", () => {
    expect(
      propertyKindsForUpdate({
        previous: {
          tool: { version: 1, type: "ai-model", prompt: "" },
          kinds: ["document"],
        },
        next: manual,
      }),
    ).toBeNull();
  });
});
