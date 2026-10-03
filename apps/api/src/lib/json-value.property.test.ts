import { deepEquals } from "bun";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toJsonObject, withNullsOmitted } from "@/api/lib/json-value";
import { isRecord } from "@/api/lib/type-guards";
import {
  ownJsonKey,
  ownKeyJsonObject,
  prototypesIntact,
  withOwnEntry,
} from "@/api/tests/helpers/own-key-json";

// The fold's contract, spelled by an independent route: the serializer drops
// the null members of every object it visits and keeps array slots, and
// `JSON.parse` defines every key, `__proto__` included, as own data.
const nullMembersDropped = (value: Record<string, unknown>): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      isRecord(entry)
        ? Object.fromEntries(
            Object.entries(entry).filter(([, member]) => member !== null),
          )
        : entry,
    ),
  );

const nonNullJsonValue = fc.oneof(
  fc.integer(),
  fc.string({ minLength: 1, maxLength: 3 }),
  ownKeyJsonObject({ nulls: false }),
);

describe("JSON value folds keep every own key as data", () => {
  test("withNullsOmitted drops exactly the null members", () => {
    assertProperty(
      "withNullsOmitted drops exactly the null members",
      fc.property(ownKeyJsonObject({ nulls: true }), (value) => {
        const folded = withNullsOmitted(value);
        expect(deepEquals(folded, nullMembersDropped(value), true)).toBe(true);
        expect(prototypesIntact(folded)).toBe(true);
      }),
    );
  });

  test("withNullsOmitted separates values that differ in one own key", () => {
    assertProperty(
      "withNullsOmitted separates values that differ in one own key",
      fc.property(
        ownKeyJsonObject({ nulls: true }),
        fc.nat(),
        fc.tuple(ownJsonKey, nonNullJsonValue),
        (value, nodeIndex, entry) => {
          const extended = withOwnEntry({ entry, nodeIndex, value });
          expect(
            deepEquals(withNullsOmitted(value), withNullsOmitted(extended)),
          ).toBe(false);
        },
      ),
    );
  });

  test("toJsonObject copies every own key as data", () => {
    assertProperty(
      "toJsonObject copies every own key as data",
      fc.property(ownKeyJsonObject({ nulls: true }), (value) => {
        const copied = toJsonObject(value);
        expect(deepEquals(copied, value, true)).toBe(true);
        expect(prototypesIntact(copied)).toBe(true);
      }),
    );
  });
});

describe("withNullsOmitted", () => {
  test("keeps an own __proto__ key parsed from JSON", () => {
    const plain: unknown = JSON.parse('{"a":1}');
    const withProtoKey: unknown = JSON.parse('{"a":1,"__proto__":{"x":1}}');

    const folded = withNullsOmitted(withProtoKey);

    expect(deepEquals(folded, withProtoKey, true)).toBe(true);
    expect(prototypesIntact(folded)).toBe(true);
    expect(deepEquals(withNullsOmitted(plain), folded)).toBe(false);
  });
});

test("JSON conversion retains own object keys through persistence", () => {
  assertProperty(
    "JSON conversion retains own object keys through persistence",
    fc.property(
      fc.constantFrom("__proto__", "constructor", "toString"),
      fc.jsonValue(),
      (key, nested) => {
        const value = Object.fromEntries([[key, nested]]);
        const converted = toJsonObject(value);
        expect(JSON.stringify(converted)).toBe(JSON.stringify(value));
        expect(Object.hasOwn(converted, key)).toBe(true);
        expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
      },
    ),
  );
});
