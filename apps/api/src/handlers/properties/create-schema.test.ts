import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import {
  DOCUMENT_TYPE_CLASSIFIER_ROLE,
  buildPropertyParts,
  createPropertyBodySchema,
} from "@/api/lib/properties/create-schema";

describe("property creation schema", () => {
  test("tags AI single-select Document Type columns as classifiers", () => {
    const built = buildPropertyParts({
      name: "Document Type",
      contentType: "single-select",
      toolType: "ai-model",
      prompt: "Classify the document type.",
      options: [{ color: "blue", value: "Contract" }],
    });

    expect("status" in built).toBe(false);
    if ("status" in built) {
      return;
    }
    expect(built.role).toBe(DOCUMENT_TYPE_CLASSIFIER_ROLE);
  });

  test("does not tag manual Document Type columns as classifiers", () => {
    const built = buildPropertyParts({
      name: "Document Type",
      contentType: "single-select",
      toolType: "manual-input",
      options: [{ color: "blue", value: "Contract" }],
    });

    expect("status" in built).toBe(false);
    if ("status" in built) {
      return;
    }
    expect(built.role).toBeNull();
  });

  test("rejects dependency arrays above the per-property bound", () => {
    const dependency = {
      dependsOnPropertyId: Bun.randomUUIDv7(),
      condition: null,
    };
    const body = {
      name: "Bounded property",
      contentType: "text",
      dependencies: Array.from(
        { length: LIMITS.propertyDependenciesPerProperty },
        () => dependency,
      ),
    };

    expect(Value.Check(createPropertyBodySchema, body)).toBe(true);
    expect(
      Value.Check(createPropertyBodySchema, {
        ...body,
        dependencies: [...body.dependencies, dependency],
      }),
    ).toBe(false);
  });
});
