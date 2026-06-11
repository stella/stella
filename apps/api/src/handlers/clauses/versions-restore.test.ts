import { describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";

import { planClauseVersionRestore } from "./versions-restore";

describe("planClauseVersionRestore", () => {
  test("restores onto a new head version (currentVersion + 1)", () => {
    expect(
      planClauseVersionRestore({ currentVersion: 3, versionCount: 3 }),
    ).toEqual({ type: "ok", newVersion: 4 });
  });

  test("never reuses the restored version's number: head always advances", () => {
    // Even restoring version 1 of a clause at version 5 lands as 6.
    expect(
      planClauseVersionRestore({ currentVersion: 5, versionCount: 5 }),
    ).toEqual({ type: "ok", newVersion: 6 });
  });

  test("refuses once the clause is at the version cap", () => {
    expect(
      planClauseVersionRestore({
        currentVersion: 10,
        versionCount: LIMITS.clauseVersionsPerClause,
      }),
    ).toEqual({ type: "at-limit" });
  });

  test("allows the final restore one below the cap", () => {
    expect(
      planClauseVersionRestore({
        currentVersion: 10,
        versionCount: LIMITS.clauseVersionsPerClause - 1,
      }),
    ).toEqual({ type: "ok", newVersion: 11 });
  });
});
