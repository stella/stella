import { expect, test } from "bun:test";

import {
  getLegislationAdapter,
  listLegislationAdapterKeys,
  listRegisteredLegislationAdapterKeys,
} from "@/api/handlers/legislation/ingestion/adapter-registry";
import type { LegislationAdapterRegistry } from "@/api/handlers/legislation/ingestion/adapter-registry";

// The registry is total in both directions: every declared key has an adapter
// (the compiler), and every registered adapter is a declared key (the runtime
// census below). Either half alone lets a source drift into or out of
// existence without anyone deciding it.

/** Byte order, never a collator: adapter keys are opaque identifiers. */
const sortedKeys = (keys: readonly string[]): string[] =>
  [...keys].sort((left, right) => (left < right ? -1 : Number(left > right)));

test("declared keys and registered adapters are the same set", () => {
  expect(sortedKeys(listRegisteredLegislationAdapterKeys())).toEqual(
    sortedKeys(listLegislationAdapterKeys()),
  );
});

test.each([
  ["not-a-declared-key"],
  [""],
  // Inherited members are not adapters: a bare object read would answer these.
  ["toString"],
  ["constructor"],
  ["__proto__"],
  ["hasOwnProperty"],
])("the undeclared key %p resolves to no adapter", (key) => {
  // Not a fallback, not a default: an adapter_key no build declares is a
  // source row the runner must refuse to run rather than guess at.
  expect(getLegislationAdapter(key)).toBeUndefined();
});

// The half the runtime census cannot reach while both sets are empty: that a
// declared key with no adapter behind it does not compile. Exercised against
// the registry's own mapped type rather than a copy of it, so the guard
// cannot drift from the thing it guards.
test("a declared key with no adapter is a compile error", () => {
  // @ts-expect-error -- the key is declared and no adapter is registered for it
  const incomplete: LegislationAdapterRegistry<"example-source"> = {};
  expect(Object.keys(incomplete)).toHaveLength(0);
});
