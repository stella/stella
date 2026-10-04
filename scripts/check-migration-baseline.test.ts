import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  describeBaselineAdditionViolation,
  findBaselineAdditionViolations,
  parseBaselineEntries,
} from "./check-migration-baseline";
import { MIGRATION_SAFETY_RULE_IDS } from "./migration-safety-rule-ids";

const MERGED = "apps/api/drizzle/20260101000000_merged/migration.sql";
const OTHER_MERGED = "apps/api/drizzle/20260102000000_other/migration.sql";
const ADDED = "apps/api/drizzle/20260103000000_added/migration.sql";
const BASE_RULE_IDS = ["drop-object", "delete-data"];
const NEW_RULE_ID = "volatile-data-write";

type Overrides = Partial<Parameters<typeof findBaselineAdditionViolations>[0]>;

const check = (overrides: Overrides) =>
  findBaselineAdditionViolations({
    baseEntries: new Set([OTHER_MERGED]),
    headEntries: [OTHER_MERGED],
    baseFiles: new Set([MERGED, OTHER_MERGED]),
    changedFiles: new Set(),
    baseRuleIds: BASE_RULE_IDS,
    headRuleIds: BASE_RULE_IDS,
    flaggedRuleIds: () => [NEW_RULE_ID],
    ...overrides,
  });

const withNewRule = {
  headRuleIds: [...BASE_RULE_IDS, NEW_RULE_ID],
} satisfies Overrides;

describe("migration baseline additions", () => {
  test("removing an entry passes", () => {
    expect(check({ headEntries: [] })).toEqual([]);
  });

  test("an unchanged baseline passes without a rule change", () => {
    expect(check({})).toEqual([]);
  });

  test("adding an entry without a rule change fails", () => {
    expect(check({ headEntries: [OTHER_MERGED, MERGED] })).toEqual([
      { type: "no-new-rule", entry: MERGED },
    ]);
  });

  test("removing a rule does not permit an addition", () => {
    expect(
      check({ headEntries: [MERGED], headRuleIds: ["drop-object"] }),
    ).toEqual([{ type: "no-new-rule", entry: MERGED }]);
  });

  test("a base without a declared rule list permits no addition", () => {
    expect(
      check({ headEntries: [MERGED], baseRuleIds: null, ...withNewRule }),
    ).toEqual([{ type: "no-base-rule-ids", entry: MERGED }]);
  });

  test("adding a merged, unchanged migration the new rule flags passes", () => {
    expect(
      check({ headEntries: [OTHER_MERGED, MERGED], ...withNewRule }),
    ).toEqual([]);
  });

  test("adding a migration the new rule does not flag fails", () => {
    expect(
      check({
        headEntries: [MERGED],
        flaggedRuleIds: () => ["drop-object"],
        ...withNewRule,
      }),
    ).toEqual([
      {
        type: "not-flagged-by-new-rule",
        entry: MERGED,
        newRuleIds: [NEW_RULE_ID],
      },
    ]);
  });

  test("adding a migration this change modifies fails even with a rule change", () => {
    expect(
      check({
        headEntries: [MERGED],
        changedFiles: new Set([MERGED]),
        ...withNewRule,
      }),
    ).toEqual([{ type: "changed", entry: MERGED }]);
  });

  test("adding a migration this change creates fails even with a rule change", () => {
    expect(
      check({
        headEntries: [ADDED],
        changedFiles: new Set([ADDED]),
        ...withNewRule,
      }),
    ).toEqual([{ type: "not-merged", entry: ADDED }]);
  });

  test("every violation has a message naming the entry", () => {
    for (const violation of check({
      headEntries: [ADDED, MERGED],
      changedFiles: new Set([ADDED]),
    })) {
      expect(describeBaselineAdditionViolation(violation)).toContain(
        violation.entry,
      );
    }
  });

  test("comments and blank lines are not entries", () => {
    expect(parseBaselineEntries(`# header\n\n${MERGED}\n  \n`)).toEqual([
      MERGED,
    ]);
  });

  test("the rule id list evaluates standalone, as the base copy is read", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rule-ids-"));
    try {
      const copy = path.join(directory, "migration-safety-rule-ids.ts");
      copyFileSync(
        path.join(import.meta.dir, "migration-safety-rule-ids.ts"),
        copy,
      );
      const standalone: unknown = await import(copy);
      expect(standalone).toMatchObject({ MIGRATION_SAFETY_RULE_IDS });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
