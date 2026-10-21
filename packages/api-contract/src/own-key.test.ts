import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { isOwnKey, ownEntry } from "./own-key";

const INHERITED_NAMES = [
  ...Object.getOwnPropertyNames(Object.prototype),
  "__proto__",
];

describe("own-key table lookups", () => {
  test("names every object inherits never resolve in a table", () => {
    const table = { TEXT_MESSAGE_CONTENT: "text", TOOL_CALL_ARGS: "tool" };
    for (const name of INHERITED_NAMES) {
      // The fixture reaches the fault: a bare lookup does resolve these.
      expect(name in table).toBe(true);
      expect(isOwnKey(table, name)).toBe(false);
      expect(ownEntry(table, name)).toBeUndefined();
    }
  });

  test("a key resolves exactly when the table has it as its own entry", () => {
    assertProperty(
      "a key resolves exactly when the table has it as its own entry",
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.oneof(fc.string(), fc.constantFrom(...INHERITED_NAMES)),
        (entries, key) => {
          const table = Object.fromEntries(Object.entries(entries));
          const own = Object.entries(table).some(([name]) => name === key);
          expect(isOwnKey(table, key)).toBe(own);
          expect(ownEntry(table, key)).toEqual(
            own
              ? Object.entries(table).find(([name]) => name === key)?.[1]
              : undefined,
          );
        },
      ),
    );
  });
});
