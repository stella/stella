import { describe, expect, test } from "bun:test";

import { OWNERSHIP } from "../../scripts/ownership.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

describe.serial("cell claim write ownership", () => {
  const entry = OWNERSHIP.find(({ id }) => id === "cell-claim-write");
  const writerPath = "apps/api/src/lib/entities/example.ts";
  const lint = async (statements: readonly string[], sourcePath = writerPath) =>
    await lintSingleRule(
      "confine-owner",
      [
        'import { fields as cells } from "@/api/db/schema";',
        ...statements,
        "",
      ].join("\n"),
      { ruleOptions: { entries: [entry] }, sourcePath, cwd: "scratch" },
    );

  test("names the four claim columns and the two owners", () => {
    expect(entry?.enforcement).toMatchObject({
      kind: "table-column-write",
      table: "fields",
      columns: ["ownerRunId", "ownerBatchId", "deadlineAt", "attempt"],
    });
    expect(entry?.owner).toEqual([
      "apps/api/src/lib/workflow-queue.ts",
      "apps/api/src/lib/workflow/orphan-cells.ts",
    ]);
  });

  test("rejects claim writes in updates, inserts, conflict sets and resolvable payloads", async () => {
    expect(
      await lint([
        "db.update(cells).set({ ownerRunId: null });",
        "db.insert(cells).values({ content, attempt: 0 });",
        "db.insert(cells).values([{ content }, { content, deadlineAt }]);",
        "db.insert(cells).values({ content }).onConflictDoUpdate({ target, set: { ownerBatchId: null } });",
        "const claim = { ownerRunId: run, attempt: 0 }; db.update(cells).set({ ...claim });",
        'db.update(cells).set({ ["ownerRunId"]: null });',
      ]),
    ).toEqual([2, 3, 4, 5, 6, 7]);
  });

  test("allows other columns, other tables, and the owners", async () => {
    expect(
      await lint([
        "db.update(cells).set({ content, aiSettlement: null });",
        "db.insert(cells).values({ ...carriedFieldValues(field), id });",
        'import { schedulerJobs } from "@/api/db/schema"; db.update(schedulerJobs).set({ attempt: 1 });',
      ]),
    ).toEqual([]);
    expect(
      await lint(
        ["db.update(cells).set({ ownerRunId: null });"],
        "apps/api/src/lib/workflow/orphan-cells.ts",
      ),
    ).toEqual([]);
  });
});
