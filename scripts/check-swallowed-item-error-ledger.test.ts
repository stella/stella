import { expect, test } from "bun:test";

import { addedEntries } from "./ledger-membership.ts";

test("handler ledger membership only shrinks after its introduction", () => {
  expect(addedEntries(["new::1"], null)).toEqual([]);
  expect(addedEntries(["old::1"], ["old::1", "removed::1"])).toEqual([]);
  expect(addedEntries(["replacement::1"], ["old::1"])).toEqual([
    "replacement::1",
  ]);
});
