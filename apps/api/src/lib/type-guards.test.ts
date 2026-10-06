import { describe, expect, test } from "bun:test";

import { isNonNullObject } from "@stll/template-conditions/path";

import { isRecord } from "@/api/lib/type-guards";

class Example {
  value = "example";
}

const cases = [
  { name: "null", value: null, object: false, record: false },
  { name: "undefined", value: undefined, object: false, record: false },
  { name: "string", value: "example", object: false, record: false },
  { name: "number", value: 1, object: false, record: false },
  { name: "boolean", value: true, object: false, record: false },
  { name: "function", value: () => "example", object: false, record: false },
  { name: "array", value: [], object: true, record: false },
  { name: "object", value: {}, object: true, record: true },
  { name: "class instance", value: new Example(), object: true, record: true },
];

describe("object predicate contracts", () => {
  test.each(cases)("non-null objects: $name", ({ value, object }) => {
    expect(isNonNullObject(value)).toBe(object);
  });

  test.each(cases)("non-array records: $name", ({ value, record }) => {
    expect(isRecord(value)).toBe(record);
  });
});
