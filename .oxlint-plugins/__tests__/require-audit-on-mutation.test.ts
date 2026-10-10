import { describe, expect, test } from "bun:test";

import { rewriteFixture } from "../../scripts/check-oxlint-fixture-counts.ts";
import { lintSingleRule } from "./lint-single-rule";

const RULE = "require-audit-on-mutation";
const SOURCE_PATH = "apps/api/src/lib/sample-store.ts";

test("the fixture reports every declared mutation diagnostic", async () => {
  const fixturePath =
    ".oxlint-plugins/__fixtures__/require-audit-on-mutation.fixture.ts";
  const fixture = await Bun.file(
    new URL(
      "../__fixtures__/require-audit-on-mutation.fixture.ts",
      import.meta.url,
    ),
  ).text();
  const rewritten = rewriteFixture(fixturePath, fixture);
  expect(rewritten.problems).toEqual([]);
  const expected = [...rewritten.expected]
    .flatMap(([key, count]) => {
      if (!key.endsWith(`:${RULE}/${RULE}`)) {
        return [];
      }
      const line = Number(
        key
          .slice(fixturePath.length + 1)
          .split(":")
          .at(0),
      );
      return Array.from({ length: count }, () => line);
    })
    .toSorted((left, right) => left - right);
  expect(expected.length).toBeGreaterThan(0);
  expect(
    await lintSingleRule(RULE, rewritten.source, { sourcePath: SOURCE_PATH }),
  ).toEqual(expected);
});

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
  test("recognizes service-client lifecycle auditing only from its canonical owner", async () => {
    const mutation = `
declare const tx: { update: (row: unknown) => void };
export const save = () => {
  tx.update({ id: "row" });
  void recordServiceClientOperatorAuditEvent({ tx });
};`;
    expect(
      await lintSingleRule(
        RULE,
        `import { recordServiceClientOperatorAuditEvent } from "@/api/lib/db/service-client-audit";${mutation}`,
        { sourcePath: SOURCE_PATH },
      ),
    ).toEqual([]);
    expect(
      await lintSingleRule(
        RULE,
        `import { recordServiceClientOperatorAuditEvent } from "./other-store";${mutation}`,
        { sourcePath: SOURCE_PATH },
      ),
    ).toEqual([4]);
  });
  test.each(["@/api/lib/audit-log", "@/api/lib/db/audit-recording"])(
    "recognizes tenant group auditing from %s",
    async (module) => {
      const mutation = `
declare const tx: { update: (row: unknown) => void };
export const save = () => {
  tx.update({ id: "row" });
  void recordAuditGroups({ tx, groups: [] });
};`;
      expect(
        await lintSingleRule(
          RULE,
          `import { recordAuditGroups } from "${module}";${mutation}`,
          { sourcePath: SOURCE_PATH },
        ),
      ).toEqual([]);
      expect(
        await lintSingleRule(
          RULE,
          `import { recordAuditGroups } from "./other-store";${mutation}`,
          { sourcePath: SOURCE_PATH },
        ),
      ).toEqual([4]);
    },
  );

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

const lintDirective = async (body: string) =>
  await lintSingleRule(
    RULE,
    [
      "declare const tx: { insert: (row: unknown) => void; delete: (row: unknown) => void };",
      "declare const rows: unknown;",
      "declare const read: () => void;",
      body,
    ].join("\n"),
    { sourcePath: SOURCE_PATH },
  );

describe("audit directive placement", () => {
  test("block-body and adjacent expression-body directives are accepted", async () => {
    expect(
      await lintDirective(
        [
          "export const block = () => {",
          "  // audit: skip - scheduler reconciliation records its own event",
          "  return tx.insert(rows);",
          "};",
          "export const expression = () =>",
          "  // audit: skip - scheduler reconciliation records its own event",
          "  tx.insert(rows);",
          "export const awaited = async () =>",
          "  // audit: skip - scheduler reconciliation records its own event",
          "  await tx.insert(rows);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a directive describes only its adjacent mutation expression", async () => {
    expect(
      await lintDirective(
        [
          "export const write = () => [",
          "  // audit: skip - scheduler reconciliation records its own event",
          "  tx.insert(rows),",
          "  tx.delete(rows)",
          "];",
        ].join("\n"),
      ),
    ).toEqual([7]);
  });

  test("a directive above another call or value leaves subsequent mutations checked", async () => {
    for (const expression of ["read()", "1"]) {
      expect(
        await lintDirective(
          [
            "export const write = () => [",
            "  // audit: skip - scheduler reconciliation records its own event",
            `  ${expression},`,
            "  tx.insert(rows)",
            "];",
          ].join("\n"),
        ),
      ).toEqual([7]);
    }
  });

  test("a gap or an unjustified reason leaves the mutation checked", async () => {
    for (const before of [
      "  // audit: skip - scheduler reconciliation records its own event\n",
      "  // audit: skip - scheduler",
      "",
    ]) {
      const directiveSource = [
        "export const write = () =>",
        before,
        "  tx.insert(rows);",
      ].join("\n");
      expect(await lintDirective(directiveSource)).toEqual([
        directiveSource.split("\n").length + 3,
      ]);
    }
  });

  test("an adjacent directive on a nested arrow leaves the parent mutation checked", async () => {
    expect(
      await lintDirective(
        [
          "export const parent = () => {",
          "  const child = () =>",
          "    // audit: skip - scheduler reconciliation records its own event",
          "    tx.insert(rows);",
          "  tx.delete(rows);",
          "  child();",
          "};",
        ].join("\n"),
      ),
    ).toEqual([8]);
  });

  test("one directive covers only the first mutation when calls share a line", async () => {
    expect(
      await lintDirective(
        [
          "export const write = () => [",
          "  // audit: skip - scheduler reconciliation records its own event",
          "  tx.insert(rows), tx.delete(rows)",
          "];",
        ].join("\n"),
      ),
    ).toEqual([6]);
  });
});

test("directive placement leaves ledger write counts identical", async () => {
  const placements = [
    [
      "export const skipped = () => {",
      "  // audit: skip - scheduler reconciliation records its own event",
      "  return tx.insert(rows);",
      "};",
    ],
    [
      "export const skipped = () =>",
      "  // audit: skip - scheduler reconciliation records its own event",
      "  tx.insert(rows);",
    ],
  ];
  for (const placement of placements) {
    const directiveSource = [
      "declare const tx: { insert: (row: unknown) => void; delete: (row: unknown) => void };",
      "declare const rows: unknown;",
      ...placement,
      "export const counted = () => tx.delete(rows);",
    ].join("\n");
    const countedLine = directiveSource.split("\n").length;
    expect(
      await lintSingleRule(RULE, directiveSource, {
        sourcePath: SOURCE_PATH,
        ruleOptionsForRoot: (root) => ({ root, census: true }),
      }),
    ).toEqual([countedLine]);
    expect(
      await lintSingleRule(RULE, directiveSource, {
        sourcePath: SOURCE_PATH,
        ruleOptionsForRoot: (root) => ({
          root,
          budgets: { [`${SOURCE_PATH}::counted`]: { "delete:rows": 1 } },
        }),
      }),
    ).toEqual([]);
  }
});
