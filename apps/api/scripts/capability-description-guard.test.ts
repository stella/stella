import { describe, expect, test } from "bun:test";

import capabilityCatalog from "../../../packages/cli/capability-catalog.json" with { type: "json" };
import ledger from "../capability-description-ledger.json" with { type: "json" };
import {
  computeLedgerDiff,
  findUndescribedIds,
} from "./capability-description-guard";
import { isRecord } from "./lib/enumerate-safe-handlers";

const readEntries = (
  catalog: unknown,
): { id: string; description?: string }[] =>
  (Array.isArray(catalog) ? catalog : []).map((entry: unknown) => {
    if (!isRecord(entry)) {
      throw new TypeError("capability catalog entry is not an object");
    }
    const id = entry["id"];
    const description = entry["description"];
    if (typeof id !== "string") {
      throw new TypeError("capability catalog entry has no string id");
    }
    return typeof description === "string" ? { id, description } : { id };
  });

const entries = readEntries(capabilityCatalog);
const ledgerIds: string[] = Array.isArray(ledger) ? ledger : [];

/** Every subset of `items`, so a property can be driven over the whole
 *  input class rather than a sampled one. */
const subsetsOf = <T>(items: readonly T[]): T[][] => {
  const subsets: T[][] = [[]];
  for (const item of items) {
    const extended = subsets.map((subset) => [...subset, item]);
    subsets.push(...extended);
  }
  return subsets;
};

describe("committed ledger", () => {
  // The ledger is only useful if it is exactly the missing set: a superset
  // overstates the remaining work and a subset hides a real gap. Asserting both
  // directions here is the same invariant the CI guard enforces, pinned against
  // the real committed artifacts rather than a fixture.
  test("is exactly the set of capabilities without a description", () => {
    const undescribed = findUndescribedIds(entries);
    expect([...ledgerIds].sort()).toEqual(undescribed);
  });

  test("is sorted, duplicate-free, and free of unknown or paid entries", () => {
    const diff = computeLedgerDiff({
      undescribed: findUndescribedIds(entries),
      ledger: ledgerIds,
      catalogIds: entries.map(({ id }) => id),
    });
    expect(diff).toEqual({
      unledgered: [],
      described: [],
      unknown: [],
      malformed: [],
    });
  });
});

describe("computeLedgerDiff", () => {
  // Invariant over the whole input class rather than one worked example: every
  // id that is undescribed-or-ledgered must be accounted for by exactly one
  // outcome, so no discrepancy can fall between the categories and pass silently.
  test("classifies every discrepancy into exactly one category", () => {
    const catalogIds = ["a", "b", "c", "d", "e"];
    for (const undescribed of subsetsOf(catalogIds)) {
      for (const ledgered of subsetsOf(catalogIds)) {
        const { unledgered, described, unknown, malformed } = computeLedgerDiff(
          { undescribed, ledger: ledgered, catalogIds },
        );
        expect(malformed).toEqual([]);
        expect(unknown).toEqual([]);
        // Symmetric difference of the two sets, and nothing else.
        const flagged = [...unledgered, ...described].sort();
        const undescribedSet = new Set(undescribed);
        const ledgeredSet = new Set(ledgered);
        const expected = catalogIds
          .filter((id) => undescribedSet.has(id) !== ledgeredSet.has(id))
          .sort();
        expect(flagged).toEqual(expected);
        expect(new Set(flagged).size).toBe(flagged.length);
      }
    }
  });

  test("a ledger entry outside the catalog is unknown, never new debt", () => {
    expect(
      computeLedgerDiff({
        undescribed: ["a"],
        ledger: ["a", "ghost"],
        catalogIds: ["a"],
      }),
    ).toEqual({
      unledgered: [],
      described: [],
      unknown: ["ghost"],
      malformed: [],
    });
  });
});

describe("findUndescribedIds", () => {
  test("treats absent, empty, and whitespace-only prose alike", () => {
    expect(
      findUndescribedIds([
        { id: "kept", description: "Does a thing." },
        { id: "absent" },
        { id: "empty", description: "" },
        { id: "blank", description: "\n\t " },
      ]),
    ).toEqual(["absent", "blank", "empty"]);
  });
});
