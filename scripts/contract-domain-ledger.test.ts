import { expect, test } from "bun:test";

import { parseContractDomainLedger } from "./contract-domain-ledger.ts";
import { renameEntries } from "./git-renames.ts";
import { addedEntries } from "./ledger-membership.ts";

const site = (id: string) => ({
  id,
  reason: "Existing input bound pending contract migration.",
});
const first = "apps/web/src/form.tsx::form::maxLength:200::1";
const second = "apps/web/src/form.tsx::form::maxLength:200::2";

test("ledger membership rejects replacement sites and additional occurrences", () => {
  const current = parseContractDomainLedger(
    JSON.stringify([site(first), site(second)]),
    "ledger",
  );
  expect(
    addedEntries(
      current.map((entry) => entry.id),
      [first],
    ),
  ).toEqual([second]);
  expect(addedEntries([second], [first])).toEqual([second]);
  expect(addedEntries([first], [first, second])).toEqual([]);
});

test("ledger rejects unreasoned, malformed, duplicate and unsorted entries", () => {
  expect(() =>
    parseContractDomainLedger(
      JSON.stringify([{ id: first, reason: " " }]),
      "ledger",
    ),
  ).toThrow("must be a reasoned ledger");
  expect(() =>
    parseContractDomainLedger(JSON.stringify([site("form.tsx:42")]), "ledger"),
  ).toThrow("invalid site key");
  expect(() =>
    parseContractDomainLedger(
      JSON.stringify([site(first), site(first)]),
      "ledger",
    ),
  ).toThrow("sorted and duplicate-free");
  expect(() =>
    parseContractDomainLedger(
      JSON.stringify([site(second), site(first)]),
      "ledger",
    ),
  ).toThrow("sorted and duplicate-free");
});

test("ledger membership follows a moved file", () => {
  const moved = "apps/web/src/moved/form.tsx::form::maxLength:200::1";
  const renames = new Map([
    ["apps/web/src/form.tsx", "apps/web/src/moved/form.tsx"],
  ]);
  expect(addedEntries([moved], renameEntries([first], renames))).toEqual([]);
  expect(addedEntries([first], renameEntries([first], new Map()))).toEqual([]);
});
