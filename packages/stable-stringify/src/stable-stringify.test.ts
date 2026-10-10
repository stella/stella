import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isDeepStrictEqual } from "node:util";

import { assertProperty } from "@stll/property-testing";

import {
  type StableStringifyInput,
  stableStringify,
} from "./stable-stringify.js";

describe("stableStringify", () => {
  test("is insensitive to the order keys were assembled in", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(
      stableStringify({ a: 2, b: 1 }),
    );
  });

  test("orders keys by UTF-16 code unit, not by locale", () => {
    // Under cs collation "ch" sorts after "h"; the output must not follow
    // that rule, or two runtimes would fingerprint the same value differently.
    expect(stableStringify({ ia: 1, cha: 2, ha: 3 })).toBe(
      '{"cha":2,"ha":3,"ia":1}',
    );
  });

  test("orders a supplementary-plane key by its surrogates", () => {
    // U+1F600 (D83D DE00) sorts before U+E000 under code-unit order. Stored
    // fingerprints were computed this way, so the order is pinned.
    expect(stableStringify({ "\uE000": 1, "\u{1F600}": 2 })).toBe(
      '{"\u{1F600}":2,"\uE000":1}',
    );
  });

  test("rejects a live instance at the type level", () => {
    // A Date, Map, or Set carries no enumerable own keys, so serializing one
    // would read as `{}` and collide with every other instance. The input
    // type keeps them off the call site; these lines fail to compile, and the
    // directive fails the build if they ever start compiling.
    // @ts-expect-error - a Date is not JSON-shaped input
    stableStringify(new Date(0));
    // @ts-expect-error - a Map is not JSON-shaped input
    stableStringify(new Map([["a", 1]]));
    // @ts-expect-error - a Set is not JSON-shaped input
    stableStringify(new Set([1]));
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
    const { named } = { named() {} };
    expect(stableStringify(named)).toBe("[function named]");
    expect(stableStringify(() => 1)).toContain("[function");
  });

  test("reports a cycle instead of throwing", () => {
    const value: Record<string, StableStringifyInput> = { name: "root" };
    value["self"] = value;
    expect(stableStringify(value)).toBe('{"name":"root","self":[circular]}');
  });

  test("walks arrays and nested objects", () => {
    expect(stableStringify([{ b: 1, a: [2, null] }, true])).toBe(
      '[{"a":[2,null],"b":1},true]',
    );
  });

  test("serializes shared references in full", () => {
    const shared = { a: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });

  test("distinguishes payloads that place a shared object differently", () => {
    const shared = { value: 1 };
    expect(stableStringify({ a: shared, b: shared })).not.toBe(
      stableStringify({ a: shared, b: { value: 2 } }),
    );
  });

  test('keeps the cycle marker distinct from the string "[circular]"', () => {
    const cycle: StableStringifyInput[] = [];
    cycle.push(cycle);
    expect(stableStringify(cycle)).not.toBe(stableStringify(["[circular]"]));
  });
});

const reverseObjectKeys = (value: fc.JsonValue): fc.JsonValue => {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toReversed()
        .map(([key, entryValue = null]) => [
          key,
          reverseObjectKeys(entryValue),
        ]),
    );
  }
  return value;
};

/** A structural copy: every object and array gets its own identity. */
const expandShared = (value: fc.JsonValue): fc.JsonValue => {
  if (Array.isArray(value)) {
    return value.map(expandShared);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue = null]) => [
        key,
        expandShared(entryValue),
      ]),
    );
  }
  return value;
};

test("values that reuse a subvalue serialize as their structural expansion", () => {
  assertProperty(
    "values that reuse a subvalue serialize as their structural expansion",
    fc.property(
      fc.dictionary(fc.string(), fc.jsonValue()),
      fc.integer({ min: 2, max: 5 }),
      (shared, uses) => {
        // One object identity at several places, directly and nested.
        const graph: fc.JsonValue = Array.from({ length: uses }, (_, index) =>
          index % 2 === 0 ? shared : { nested: [shared] },
        );
        expect(stableStringify(graph)).toBe(
          stableStringify(expandShared(graph)),
        );
      },
    ),
  );
});

test("acyclic JSON values have injective, key-order-independent serialization", () => {
  assertProperty(
    "acyclic JSON values have injective, key-order-independent serialization",
    fc.property(fc.jsonValue(), fc.jsonValue(), (left, right) => {
      expect(stableStringify(reverseObjectKeys(left))).toBe(
        stableStringify(left),
      );
      if (!isDeepStrictEqual(left, right)) {
        expect(stableStringify(left)).not.toBe(stableStringify(right));
      }
    }),
  );
});
