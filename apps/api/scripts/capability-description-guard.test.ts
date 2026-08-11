import { describe, expect, test } from "bun:test";

import cliCatalog from "../../../packages/cli/src/generated/capability-catalog.json" with { type: "json" };
import ledger from "../capability-description-ledger.json" with { type: "json" };
import apiCatalog from "../src/mcp/generated/capability-catalog.json" with { type: "json" };
import {
  computeLedgerDiff,
  findMirrorDrift,
  findUndescribedIds,
} from "./capability-description-guard";
import { isRecord } from "./lib/enumerate-safe-handlers";

const readEntries = (
  catalog: unknown,
): { id: string; description?: string }[] =>
  (Array.isArray(catalog) ? catalog : []).map((entry: unknown) => {
    if (!isRecord(entry)) {
      throw new Error("capability catalog entry is not an object");
    }
    const id = entry["id"];
    const description = entry["description"];
    if (typeof id !== "string") {
      throw new Error("capability catalog entry has no string id");
    }
    return typeof description === "string" ? { id, description } : { id };
  });

const apiEntries = readEntries(apiCatalog);
const cliEntries = readEntries(cliCatalog);
const ledgerIds: string[] = Array.isArray(ledger) ? ledger : [];

describe("committed ledger", () => {
  // The ledger is only useful if it is exactly the missing set: a superset
  // overstates the remaining work and a subset hides a real gap. Asserting both
  // directions here is the same invariant the CI guard enforces, pinned against
  // the real committed artifacts rather than a fixture.
  test("is exactly the set of capabilities without a description", () => {
    const undescribed = findUndescribedIds(apiEntries);
    expect([...ledgerIds].sort()).toEqual(undescribed);
  });

  test("is sorted, duplicate-free, and free of unknown or paid entries", () => {
    const diff = computeLedgerDiff({
      undescribed: findUndescribedIds(apiEntries),
      ledger: ledgerIds,
      catalogIds: apiEntries.map(({ id }) => id),
    });
    expect(diff).toEqual({
      unledgered: [],
      described: [],
      unknown: [],
      malformed: [],
    });
  });

  test("both catalog mirrors agree on which capabilities lack prose", () => {
    expect(
      findMirrorDrift([
        { path: "api", undescribed: findUndescribedIds(apiEntries) },
        { path: "cli", undescribed: findUndescribedIds(cliEntries) },
      ]),
    ).toEqual([]);
  });
});

describe("computeLedgerDiff", () => {
  // Invariant over the whole input class rather than one worked example: every
  // id that is undescribed-or-ledgered must be accounted for by exactly one
  // outcome, so no discrepancy can fall between the categories and pass silently.
  test("classifies every discrepancy into exactly one category", () => {
    const catalogIds = ["a", "b", "c", "d", "e"];
    for (let mask = 0; mask < 1 << (catalogIds.length * 2); mask += 1) {
      const undescribed = catalogIds.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const ledgered = catalogIds.filter(
        (_, index) => (mask & (1 << (index + catalogIds.length))) !== 0,
      );
      const { unledgered, described, unknown, malformed } = computeLedgerDiff({
        undescribed,
        ledger: ledgered,
        catalogIds,
      });
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
