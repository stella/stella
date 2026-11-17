import { describe, expect, test } from "bun:test";

import { parseCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-load";
import ledger from "../capability-file-transport-ledger.json" with { type: "json" };
import { repositoryCapabilityCatalog } from "../src/tests/helpers/repository-capability-catalog";
import {
  computeLedgerDiff,
  findSuppressedIds,
} from "./capability-file-transport-guard";

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

// The entries the runtime generator derived from the handler graph; the CI
// guard derives the same catalog in memory.
const entries = parseCapabilityCatalog(repositoryCapabilityCatalog) ?? [];

describe("capability file-transport ledger", () => {
  test("measures the catalog derived from handlers, never an absent artifact", () => {
    expect(entries.length).toBeGreaterThan(300);
    const suppressed = findSuppressedIds(entries);
    // A count read from missing files would be 0 and pass any ceiling.
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed).toEqual([...ledger]);
  });

  test("counts byte responses and required file inputs, never optional ones", () => {
    expect(
      findSuppressedIds([
        { id: "a.list", transport: { type: "json" } },
        {
          id: "b.import",
          transport: {
            type: "file-input",
            input: { field: "file", required: false },
          },
        },
        {
          id: "c.upload",
          transport: {
            type: "file-input",
            input: { field: "file", required: true },
          },
        },
        { id: "d.export", transport: { type: "file-response" } },
        {
          id: "e.convert",
          transport: {
            type: "file-both",
            input: { field: "file", required: false },
          },
        },
      ]),
    ).toEqual(["c.upload", "d.export", "e.convert"]);
  });
});

describe("computeLedgerDiff", () => {
  // Every id that is suppressed-or-ledgered must be accounted for by exactly one
  // outcome, so no discrepancy can fall between the categories and pass silently.
  test("classifies every discrepancy into exactly one category", () => {
    const catalogIds = ["a", "b", "c", "d", "e"];
    for (const suppressed of subsetsOf(catalogIds)) {
      for (const ledgered of subsetsOf(catalogIds)) {
        const { unledgered, invocable, unknown, malformed } = computeLedgerDiff(
          { suppressed, ledger: ledgered, catalogIds },
        );
        expect(malformed).toEqual([]);
        expect(unknown).toEqual([]);
        // Symmetric difference of the two sets, and nothing else.
        const flagged = [...unledgered, ...invocable].toSorted();
        const suppressedSet = new Set(suppressed);
        const ledgeredSet = new Set(ledgered);
        const expected = catalogIds
          .filter((id) => suppressedSet.has(id) !== ledgeredSet.has(id))
          .toSorted();
        expect(flagged).toEqual(expected);
        expect(new Set(flagged).size).toBe(flagged.length);
      }
    }
  });

  test("a ledger entry outside the catalog is unknown, never new debt", () => {
    expect(
      computeLedgerDiff({
        suppressed: ["a"],
        ledger: ["a", "ghost"],
        catalogIds: ["a"],
      }),
    ).toEqual({
      unledgered: [],
      invocable: [],
      unknown: ["ghost"],
      malformed: [],
    });
  });

  test("an unsorted or duplicated ledger is malformed", () => {
    expect(
      computeLedgerDiff({
        suppressed: ["a", "b"],
        ledger: ["b", "a", "a"],
        catalogIds: ["a", "b"],
      }).malformed,
    ).toEqual(["a", "b"]);
  });
});
