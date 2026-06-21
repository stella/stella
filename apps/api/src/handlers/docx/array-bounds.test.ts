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

  test("rejects an omitted required array as length 0 (minItems)", () => {
    const m = manifest([{ path: "lawyers", validation: { minItems: 2 } }]);
    // A non-array value and a fully omitted path both count as length 0, so a
    // positive minItems must reject them (otherwise a required loop renders
    // zero items).
    expect(checkArrayBounds({ lawyers: "not an array" }, m)).toContain(
      "at least 2",
    );
    expect(checkArrayBounds({}, m)).toContain("at least 2");
  });

  test("an omitted array passes maxItems-only bounds (nothing to cap)", () => {
    const m = manifest([{ path: "lawyers", validation: { maxItems: 3 } }]);
    expect(checkArrayBounds({}, m)).toBeNull();
    expect(checkArrayBounds({ lawyers: "not an array" }, m)).toBeNull();
  });

  test("a condition-gated container is not over-rejected when omitted", () => {
    // A loop whose own container field carries a boolean rule condition may be
    // legitimately suppressed, so its array being absent is allowed even with a
    // positive minItems (checkArrayBounds runs before block expansion and
    // cannot see the document's {{#if}} structure).
    const m = manifest([
      {
        path: "lawyers",
        validation: { minItems: 2 },
        condition: 'kind == "firm"',
      },
    ]);
    expect(checkArrayBounds({}, m)).toBeNull();
    // But a present array under a gated container still honors its bounds.
    const tooMany = manifest([
      {
        path: "lawyers",
        validation: { maxItems: 1 },
        condition: 'kind == "firm"',
      },
    ]);
    expect(checkArrayBounds({ lawyers: [{}, {}] }, tooMany)).toContain(
      "at most 1",
    );
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
