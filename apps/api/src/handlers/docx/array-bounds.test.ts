import { describe, expect, test } from "bun:test";

import { checkArrayBounds } from "./array-bounds";
import type { FieldMeta } from "./types";

const manifest = (fields: FieldMeta[]): { fields: FieldMeta[] } => ({ fields });

describe("checkArrayBounds", () => {
  test("returns null with no manifest", () => {
    expect(checkArrayBounds({ lawyers: [] }, null)).toBeNull();
  });

  test("returns null when no field declares item bounds", () => {
    const m = manifest([{ path: "lawyers" }]);
    expect(checkArrayBounds({ lawyers: [1, 2] }, m)).toBeNull();
  });

  test("rejects below minItems", () => {
    const m = manifest([{ path: "lawyers", validation: { minItems: 2 } }]);
    const result = checkArrayBounds({ lawyers: [{ name: "a" }] }, m);
    expect(result).toContain("at least 2");
  });

  test("rejects above maxItems", () => {
    const m = manifest([{ path: "lawyers", validation: { maxItems: 1 } }]);
    const result = checkArrayBounds({ lawyers: [{}, {}] }, m);
    expect(result).toContain("at most 1");
  });

  test("accepts a length within [minItems, maxItems]", () => {
    const m = manifest([
      { path: "lawyers", validation: { minItems: 1, maxItems: 3 } },
    ]);
    expect(checkArrayBounds({ lawyers: [{}, {}] }, m)).toBeNull();
  });

  test("names the field label in the message when present", () => {
    const m = manifest([
      { path: "lawyers", label: "Lawyers", validation: { minItems: 2 } },
    ]);
    expect(checkArrayBounds({ lawyers: [] }, m)).toContain('"Lawyers"');
  });

  test("skips non-array values (left for other diagnostics)", () => {
    const m = manifest([{ path: "lawyers", validation: { minItems: 2 } }]);
    expect(checkArrayBounds({ lawyers: "not an array" }, m)).toBeNull();
    expect(checkArrayBounds({}, m)).toBeNull();
  });

  test("resolves a flat dotted container key (fill_template tool shape)", () => {
    const m = manifest([{ path: "a.lawyers", validation: { maxItems: 1 } }]);
    expect(checkArrayBounds({ "a.lawyers": [{}, {}] }, m)).toContain(
      "at most 1",
    );
  });

  test("resolves a nested container path (fill form shape)", () => {
    const m = manifest([{ path: "a.lawyers", validation: { minItems: 1 } }]);
    expect(checkArrayBounds({ a: { lawyers: [] } }, m)).toContain("at least 1");
  });
});
