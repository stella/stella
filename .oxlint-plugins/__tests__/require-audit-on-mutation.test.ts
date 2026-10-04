import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "require-audit-on-mutation";
const SOURCE_PATH = "apps/api/src/lib/sample-store.ts";

// Three owners: `saveRow` writes twice to `rows` inside an anonymous
// transaction callback, `clearRows` deletes once, and two `try` callbacks in
// different functions each write once.
const source = `
type Writer = { insert: (value: unknown) => void; delete: (value: unknown) => void };
declare const db: { transaction: (run: (tx: Writer) => void) => void };
declare const rows: unknown;
declare const audits: unknown;
declare const attempt: (step: { try: () => void }) => void;

export const saveRow = () => {
  db.transaction((tx) => {
    tx.insert(rows);
    tx.insert(rows);
  });
};

export function clearRows(tx: Writer) {
  tx.delete(rows);
}

export const first = (tx: Writer) => attempt({ try: () => tx.insert(rows) });
export const second = (tx: Writer) => attempt({ try: () => tx.insert(audits) });
`;

type Budgets = Record<string, Record<string, number>>;

const AT_BUDGET: Budgets = {
  saveRow: { "insert:rows": 2 },
  clearRows: { "delete:rows": 1 },
  "first.try": { "insert:rows": 1 },
  "second.try": { "insert:audits": 1 },
};

const lint = async (budgets: Budgets | null) =>
  await lintSingleRule(RULE, source, {
    sourcePath: SOURCE_PATH,
    ...(budgets === null
      ? {}
      : {
          ruleOptionsForRoot: (root: string) => ({
            budgets: Object.fromEntries(
              Object.entries(budgets).map(([owner, writes]) => [
                `${SOURCE_PATH}::${owner}`,
                writes,
              ]),
            ),
            root,
          }),
        }),
  });

describe("require-audit-on-mutation ledger budgets", () => {
  test("a file without ledger rows is held to the full rule", async () => {
    expect(await lint(null)).toEqual([10, 11, 16, 19, 20]);
  });

  test("owners at their budget pass, keyed by the path of named functions", async () => {
    expect(await lint(AT_BUDGET)).toEqual([]);
  });

  test("an owner over its budget reports every write to that target", async () => {
    expect(await lint({ ...AT_BUDGET, saveRow: { "insert:rows": 1 } })).toEqual(
      [10, 11],
    );
  });

  test("a write to another target is not covered by the same count", async () => {
    // Same count, different table: the swapped-in write is new.
    expect(
      await lint({ ...AT_BUDGET, clearRows: { "delete:audits": 1 } }),
    ).toHaveLength(2);
  });

  test("same-named callbacks in different functions are separate owners", async () => {
    expect(
      await lint({
        ...AT_BUDGET,
        "first.try": { "insert:rows": 1, "insert:audits": 1 },
        "second.try": {},
      }),
    ).toEqual([2, 20]);
  });

  test("an owner the ledger does not name has no budget", async () => {
    const { clearRows: _cleared, ...rest } = AT_BUDGET;
    expect(await lint(rest)).toEqual([16]);
  });

  test("a budget above the current count is reported as stale", async () => {
    expect(
      await lint({ ...AT_BUDGET, saveRow: { "insert:rows": 3 } }),
    ).toHaveLength(1);
  });
});

const MEMBER_RUN_PATH = "apps/api/src/lib/flows/flow-executor.ts";
// Every write in the fixture, reported when no budget or registration covers
// the file; a rejected registration also reports the program (line 2).
const FIXTURE_WRITE_LINES = [10, 11, 16, 19, 20];

const lintSystemModule = async (
  sourcePath: string,
  systemModules: Record<string, string>,
) =>
  await lintSingleRule(RULE, source, {
    sourcePath,
    ruleOptionsForRoot: (root: string) => ({ root, systemModules }),
  });

describe("require-audit-on-mutation system modules", () => {
  test("a registered system module's writes are audited by its actor's run", async () => {
    expect(
      await lintSystemModule(SOURCE_PATH, {
        [SOURCE_PATH]: "system:file-comparison-sweep",
      }),
    ).toEqual([]);
  });

  test("a module registered to an unknown actor is reported and stays held to the rule", async () => {
    expect(
      await lintSystemModule(SOURCE_PATH, {
        [SOURCE_PATH]: "system:not-an-actor",
      }),
    ).toEqual([2, ...FIXTURE_WRITE_LINES]);
  });

  test("a member-run module cannot be registered as a system module", async () => {
    expect(
      await lintSystemModule(MEMBER_RUN_PATH, {
        [MEMBER_RUN_PATH]: "system:file-comparison-sweep",
      }),
    ).toEqual([2, ...FIXTURE_WRITE_LINES]);
  });

  test("another file's registration does not cover this one", async () => {
    expect(
      await lintSystemModule(SOURCE_PATH, {
        "apps/api/src/lib/other-store.ts": "system:file-comparison-sweep",
      }),
    ).toEqual(FIXTURE_WRITE_LINES);
  });

  test("a function that records through recordSystemAudit is audited; a local namesake is not", async () => {
    const recorded = `
import { recordSystemAudit } from "@/api/lib/system-audit/record";

type Writer = { insert: (value: unknown) => void };

export const sweep = async (db: Writer) => {
  db.insert({ id: "one" });
  await recordSystemAudit(db, "system:file-comparison-sweep", {
    subject: "run",
    counts: { sweptUploads: 1 },
  });
};

const recordSystemAuditLocally = async (_db: Writer) => {};

export const unaudited = async (db: Writer) => {
  db.insert({ id: "two" });
  await recordSystemAuditLocally(db);
};
`;
    expect(
      await lintSingleRule(RULE, recorded, { sourcePath: SOURCE_PATH }),
    ).toEqual([17]);
  });
});
