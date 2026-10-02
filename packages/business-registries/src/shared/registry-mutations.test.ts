import { expect, test } from "bun:test";

import { forEachRegistryMutation } from "./property-test-helpers.test.js";

test.each([
  { payload: { absent: null, nested: [null, "value"] }, count: 10 },
  { payload: [null, { absent: null, present: "value" }], count: 10 },
  { payload: { absent: null }, count: 2 },
  { payload: [null], count: 2 },
])(
  "every eligible registry field mutation changes the fixture: %j",
  async ({ payload, count }) => {
    const original = structuredClone(payload);
    let checked = 0;
    await forEachRegistryMutation(payload, async (mutated) => {
      expect(mutated).not.toEqual(original);
      checked += 1;
    });
    expect(checked).toBe(count);
    expect(payload).toEqual(original);
  },
);
