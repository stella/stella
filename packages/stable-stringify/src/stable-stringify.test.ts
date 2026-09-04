import { describe, expect, test } from "bun:test";

import { stableStringify } from "./stable-stringify";

describe("stableStringify", () => {
  test("is insensitive to the order keys were assembled in", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(
      stableStringify({ a: 2, b: 1 }),
    );
  });

  test("orders keys by codepoint, not by locale", () => {
    // Under cs collation "ch" sorts after "h"; the output must not follow
    // that rule, or two runtimes would fingerprint the same value differently.
    expect(stableStringify({ ia: 1, cha: 2, ha: 3 })).toBe(
      '{"cha":2,"ha":3,"ia":1}',
    );
  });

  test("keeps an explicitly-undefined key distinguishable from an absent one", () => {
    expect(stableStringify({ a: 1, b: undefined })).not.toBe(
      stableStringify({ a: 1 }),
    );
    expect(stableStringify(undefined)).toBe("undefined");
  });

  test("serializes values JSON has no form for", () => {
    expect(stableStringify(10n)).toBe("10n");
    expect(stableStringify(Symbol("tag"))).toBe("Symbol(tag)");
    expect(stableStringify(function named() {})).toBe("[function named]");
    expect(stableStringify(() => 1)).toContain("[function");
  });

  test("reports a cycle instead of throwing", () => {
    const value: Record<string, unknown> = { name: "root" };
    value["self"] = value;
    expect(stableStringify(value)).toBe('{"name":"root","self":[circular]}');
  });

  test("walks arrays and nested objects", () => {
    expect(stableStringify([{ b: 1, a: [2, null] }, true])).toBe(
      '[{"a":[2,null],"b":1},true]',
    );
  });

  test("reads a repeated reference as circular too", () => {
    // The visited set is never unwound, so the second appearance of the same
    // object is reported like a cycle. Callers fingerprint payloads they
    // built, not object graphs they share.
    const shared = { a: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"a":1},[circular]]');
  });
});
