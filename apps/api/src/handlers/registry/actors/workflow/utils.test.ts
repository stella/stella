import { describe, expect, test } from "bun:test";

import type {
  FieldContent,
  PropertyCondition,
} from "@/api/db/schema-validators";
import type {
  BatchProperty,
  PropertyBatch,
} from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import {
  evaluateCondition,
  prepareBatch,
} from "@/api/handlers/registry/actors/workflow/utils";

const createBatchProperty = (
  id: string,
  overrides: Partial<BatchProperty> = {},
): BatchProperty => ({
  id,
  status: "fresh",
  content: { version: 1, type: "text" },
  tool: { version: 1, type: "ai-model", prompt: "test" },
  dependencies: [],
  ...overrides,
});

const createRawBatch = (
  properties: BatchProperty[],
  overrides: Partial<PropertyBatch> = {},
): PropertyBatch => ({
  id: "batch-1",
  inputs: [],
  properties,
  ...overrides,
});

describe("evaluateCondition", () => {
  const eqCondition: PropertyCondition = {
    version: 1,
    type: "string",
    operator: "eq",
    value: "x",
  };

  const textFieldX: FieldContent = {
    type: "text",
    version: 1,
    value: "x",
  };

  test("returns false for error field content regardless of condition", () => {
    const fieldContent: FieldContent = {
      type: "error",
      version: 1,
    };

    expect(evaluateCondition(fieldContent, eqCondition)).toBe(false);
  });

  test("returns false for pending field content regardless of condition", () => {
    const fieldContent: FieldContent = {
      type: "pending",
      version: 1,
    };

    expect(evaluateCondition(fieldContent, eqCondition)).toBe(false);
  });

  test("returns false for file field content regardless of condition", () => {
    const fieldContent: FieldContent = {
      type: "file",
      version: 1,
      id: "test-id-000000000000",
      fileName: "test.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      encrypted: false,
      sha256Hex:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      pdfFileId: null,
    };

    expect(evaluateCondition(fieldContent, eqCondition)).toBe(false);
  });

  test("returns true for string eq when values match exactly", () => {
    expect(evaluateCondition(textFieldX, eqCondition)).toBe(true);
  });

  test("returns false for string eq when field has empty string and condition expects non-empty", () => {
    const fieldContent: FieldContent = {
      type: "text",
      version: 1,
      value: "",
    };

    expect(evaluateCondition(fieldContent, eqCondition)).toBe(false);
  });

  test("returns true for contains-every when field array is superset of condition values", () => {
    const condition: PropertyCondition = {
      version: 1,
      type: "string-array",
      operator: "contains-every",
      value: ["a", "b"],
    };
    const fieldContent: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a", "b", "c"],
    };

    expect(evaluateCondition(fieldContent, condition)).toBe(true);
  });

  test("returns true for contains-every when field array matches exactly", () => {
    const condition: PropertyCondition = {
      version: 1,
      type: "string-array",
      operator: "contains-every",
      value: ["a", "b"],
    };
    const fieldContent: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a", "b"],
    };

    expect(evaluateCondition(fieldContent, condition)).toBe(true);
  });

  test("returns false for contains-every when field array lacks one required value", () => {
    const condition: PropertyCondition = {
      version: 1,
      type: "string-array",
      operator: "contains-every",
      value: ["a", "b", "c"],
    };
    const fieldContent: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a", "b"],
    };

    expect(evaluateCondition(fieldContent, condition)).toBe(false);
  });

  test("returns false for contains-every when field array is empty", () => {
    const condition: PropertyCondition = {
      version: 1,
      type: "string-array",
      operator: "contains-every",
      value: ["a"],
    };
    const fieldContent: FieldContent = {
      type: "multi-select",
      version: 1,
      value: [],
    };

    expect(evaluateCondition(fieldContent, condition)).toBe(false);
  });

  test("returns false when condition type is string but field is multi-select", () => {
    const fieldContent: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a"],
    };

    expect(evaluateCondition(fieldContent, eqCondition)).toBe(false);
  });

  test("returns false when condition type is string-array but field is text", () => {
    const condition: PropertyCondition = {
      version: 1,
      type: "string-array",
      operator: "contains-every",
      value: ["a"],
    };

    expect(evaluateCondition(textFieldX, condition)).toBe(false);
  });

  test("returns false for single-select with null value and string condition", () => {
    const fieldContent: FieldContent = {
      type: "single-select",
      version: 1,
      value: null,
    };

    expect(evaluateCondition(fieldContent, eqCondition)).toBe(false);
  });

  test("returns true for contains-every when condition value is empty array (false positive, bad DB data)", () => {
    const condition: PropertyCondition = {
      version: 1,
      type: "string-array",
      operator: "contains-every",
      value: [],
    };
    const fieldContent: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a"],
    };

    expect(evaluateCondition(fieldContent, condition)).toBe(true);
  });
});

describe("prepareBatch", () => {
  test.each([
    ["text", "text"],
    ["single-select", "single-select"],
    ["multi-select", "multi-select"],
    ["file", "file"],
  ] as [string, FieldContent["type"]][])(
    "excludes fresh property with valid %s content",
    (_label, fieldContentType) => {
      const rawBatch = createRawBatch([
        createBatchProperty("p1", { status: "fresh" }),
      ]);
      const fieldContentMap = new Map<string, FieldContent["type"]>([
        ["p1", fieldContentType],
      ]);

      const result = prepareBatch(rawBatch, fieldContentMap);

      expect(result.properties).toHaveLength(0);
      expect(result.id).toBe(rawBatch.id);
    },
  );

  test("includes fresh property with no field content", () => {
    const rawBatch = createRawBatch([
      createBatchProperty("p1", { status: "fresh" }),
    ]);
    const fieldContentMap = new Map<string, FieldContent["type"]>();

    const result = prepareBatch(rawBatch, fieldContentMap);

    expect(result.properties).toHaveLength(1);
    expect(result.properties[0].id).toBe("p1");
  });

  test("includes fresh property with error content", () => {
    const rawBatch = createRawBatch([
      createBatchProperty("p1", { status: "fresh" }),
    ]);
    const fieldContentMap = new Map<string, FieldContent["type"]>([
      ["p1", "error"],
    ]);

    const result = prepareBatch(rawBatch, fieldContentMap);

    expect(result.properties).toHaveLength(1);
    expect(result.properties[0].id).toBe("p1");
  });

  test("includes fresh property with pending content", () => {
    const rawBatch = createRawBatch([
      createBatchProperty("p1", { status: "fresh" }),
    ]);
    const fieldContentMap = new Map<string, FieldContent["type"]>([
      ["p1", "pending"],
    ]);

    const result = prepareBatch(rawBatch, fieldContentMap);

    expect(result.properties).toHaveLength(1);
    expect(result.properties[0].id).toBe("p1");
  });

  test("includes non-fresh property regardless of field content", () => {
    const rawBatch = createRawBatch([
      createBatchProperty("p1", { status: "uninitialized" }),
      createBatchProperty("p2", { status: "stale" }),
    ]);
    const fieldContentMap = new Map<string, FieldContent["type"]>([
      ["p1", "text"],
      ["p2", "single-select"],
    ]);

    const result = prepareBatch(rawBatch, fieldContentMap);

    expect(result.properties).toHaveLength(2);
    expect(result.properties.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  test("returns empty properties when raw batch has no properties", () => {
    const rawBatch = createRawBatch([], { id: "empty-batch", inputs: ["dep"] });
    const fieldContentMap = new Map<string, FieldContent["type"]>();

    const result = prepareBatch(rawBatch, fieldContentMap);

    expect(result.properties).toHaveLength(0);
    expect(result.id).toBe("empty-batch");
    expect(result.inputs).toEqual(["dep"]);
  });
});
