import { afterAll, describe, expect, mock, test } from "bun:test";

import type { ConditionNode } from "@stll/conditions";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import type {
  AIBatchProperty,
  BatchProperty,
  PropertyBatch,
} from "@/api/lib/workflow/get-execution-plan";

// Stub registry-only side effects. Avoid mocking `@/api/db`: this test never
// loads `root.ts`, and Bun's `mock.module` leaks process-wide across files.
void mock.module("@/api/handlers/registry/utils", () => ({
  broadcastEvent: () => {},
  resetActorState: () => {},
}));

afterAll(() => {
  mock.restore();
});

const { evaluateGatingCondition, prepareBatch } =
  await import("@/api/lib/workflow/utils");

const propertyId = (value: string) => toSafeId<"property">(value);

const createBatchProperty = (
  id: string,
  overrides: Partial<AIBatchProperty> = {},
): AIBatchProperty => ({
  id: propertyId(id),
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

describe("evaluateGatingCondition", () => {
  const DEP = "dep-prop";

  const eqCondition: ConditionNode = {
    type: "compare",
    left: { type: "property", propertyId: DEP },
    op: "eq",
    right: { type: "literal", value: "x" },
  };

  const containsEvery = (value: string[]): ConditionNode => ({
    type: "predicate",
    operand: { type: "property", propertyId: DEP },
    op: "contains_all",
    value,
  });

  const map = (content: FieldContent): Map<string, FieldContent> =>
    new Map([[DEP, content]]);

  test("returns true for a null condition (no gate)", () => {
    expect(evaluateGatingCondition(null, new Map())).toBe(true);
  });

  test("returns false for error field content against an eq gate", () => {
    const content: FieldContent = { type: "error", version: 1 };
    expect(evaluateGatingCondition(eqCondition, map(content))).toBe(false);
  });

  test("returns false for pending field content against an eq gate", () => {
    const content: FieldContent = { type: "pending", version: 1 };
    expect(evaluateGatingCondition(eqCondition, map(content))).toBe(false);
  });

  test("returns false for file field content against an eq gate", () => {
    const content: FieldContent = {
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
    expect(evaluateGatingCondition(eqCondition, map(content))).toBe(false);
  });

  test("returns false when the dependency field is absent from the map", () => {
    expect(evaluateGatingCondition(eqCondition, new Map())).toBe(false);
  });

  test("returns true for string eq when values match exactly", () => {
    const content: FieldContent = { type: "text", version: 1, value: "x" };
    expect(evaluateGatingCondition(eqCondition, map(content))).toBe(true);
  });

  test("returns false for string eq when field is empty", () => {
    const content: FieldContent = { type: "text", version: 1, value: "" };
    expect(evaluateGatingCondition(eqCondition, map(content))).toBe(false);
  });

  test("returns true for contains_all when field is a superset", () => {
    const content: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a", "b", "c"],
    };
    expect(
      evaluateGatingCondition(containsEvery(["a", "b"]), map(content)),
    ).toBe(true);
  });

  test("returns true for contains_all when field matches exactly", () => {
    const content: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a", "b"],
    };
    expect(
      evaluateGatingCondition(containsEvery(["a", "b"]), map(content)),
    ).toBe(true);
  });

  test("returns false for contains_all when field lacks a required value", () => {
    const content: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a", "b"],
    };
    expect(
      evaluateGatingCondition(containsEvery(["a", "b", "c"]), map(content)),
    ).toBe(false);
  });

  test("returns false for contains_all when field array is empty", () => {
    const content: FieldContent = {
      type: "multi-select",
      version: 1,
      value: [],
    };
    expect(evaluateGatingCondition(containsEvery(["a"]), map(content))).toBe(
      false,
    );
  });

  test("returns false for single-select null value against an eq gate", () => {
    const content: FieldContent = {
      type: "single-select",
      version: 1,
      value: null,
    };
    expect(evaluateGatingCondition(eqCondition, map(content))).toBe(false);
  });

  test("returns true for contains_all when the wanted list is empty", () => {
    const content: FieldContent = {
      type: "multi-select",
      version: 1,
      value: ["a"],
    };
    expect(evaluateGatingCondition(containsEvery([]), map(content))).toBe(true);
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
    expect(result.properties[0]?.id).toBe(propertyId("p1"));
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
    expect(result.properties[0]?.id).toBe(propertyId("p1"));
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
    expect(result.properties[0]?.id).toBe(propertyId("p1"));
  });

  test("includes stale properties regardless of field content", () => {
    const rawBatch = createRawBatch([
      createBatchProperty("p1", { status: "stale" }),
      createBatchProperty("p2", { status: "stale" }),
    ]);
    const fieldContentMap = new Map<string, FieldContent["type"]>([
      ["p1", "text"],
      ["p2", "single-select"],
    ]);

    const result = prepareBatch(rawBatch, fieldContentMap);

    expect(result.properties).toHaveLength(2);
    expect(result.properties.map((p) => p.id)).toEqual([
      propertyId("p1"),
      propertyId("p2"),
    ]);
  });

  test("returns empty properties when raw batch has no properties", () => {
    const rawBatch = createRawBatch([], {
      id: "empty-batch",
      inputs: [propertyId("dep")],
    });
    const fieldContentMap = new Map<string, FieldContent["type"]>();

    const result = prepareBatch(rawBatch, fieldContentMap);

    expect(result.properties).toHaveLength(0);
    expect(result.id).toBe("empty-batch");
    expect(result.inputs).toEqual([propertyId("dep")]);
  });

  test("excludes locked properties even when status is stale", () => {
    const rawBatch = createRawBatch([
      createBatchProperty("p1", { status: "stale" }),
      createBatchProperty("p2", { status: "stale" }),
    ]);
    const fieldContentMap = new Map<string, FieldContent["type"]>();
    const locked = new Set<string>([propertyId("p1")]);

    const result = prepareBatch(rawBatch, fieldContentMap, locked);

    expect(result.properties.map((p) => p.id)).toEqual([propertyId("p2")]);
  });

  test("excludes locked properties even when content type would normally trigger re-extraction", () => {
    const rawBatch = createRawBatch([
      createBatchProperty("p1", { status: "fresh" }),
    ]);
    const fieldContentMap = new Map<string, FieldContent["type"]>([
      ["p1", "error"],
    ]);
    const locked = new Set<string>([propertyId("p1")]);

    const result = prepareBatch(rawBatch, fieldContentMap, locked);

    expect(result.properties).toHaveLength(0);
  });
});
