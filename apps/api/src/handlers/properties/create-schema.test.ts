import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_TYPE_CLASSIFIER_ROLE,
  buildPropertyParts,
} from "@/api/handlers/properties/create-schema";

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
});
