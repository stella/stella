import { describe, expect, test } from "bun:test";

import { DECLARED_SCHEDULER_JOBS, tablesForSchedulerTask } from "./jobs";
import { REGISTERED_SCHEDULER_TASK_NAMES } from "./registry";
import { assertSchedulerTableDeclarations } from "./table-declarations";

describe("scheduler table declarations", () => {
  test("every declared job names existing physical tables", () => {
    expect(DECLARED_SCHEDULER_JOBS.length).toBeGreaterThan(0);
    assertSchedulerTableDeclarations(DECLARED_SCHEDULER_JOBS);
    for (const { task, tables } of DECLARED_SCHEDULER_JOBS) {
      expect(tablesForSchedulerTask(task)).toEqual(
        [...new Set([...tables.reads, ...tables.writes])].toSorted(),
      );
    }
  });

  test("a job without a declaration is refused", () => {
    const missingDeclaration = { id: "fixture.missingTables" };
    expect(() =>
      assertSchedulerTableDeclarations([missingDeclaration]),
    ).toThrow("Scheduler job fixture.missingTables has no table declaration");
    expect(() =>
      assertSchedulerTableDeclarations([
        { id: "fixture.missingWrites", tables: { reads: [] } },
      ]),
    ).toThrow("Scheduler job fixture.missingWrites has no table declaration");
  });

  test("unknown physical tables are refused", () => {
    expect(() =>
      assertSchedulerTableDeclarations([
        {
          id: "fixture.unknownTable",
          tables: { reads: ["not_a_stella_table"], writes: [] },
        },
      ]),
    ).toThrow(
      "Scheduler job fixture.unknownTable declares unknown table not_a_stella_table",
    );
  });

  test("every registered task has a declaration, including dynamic jobs", () => {
    for (const task of REGISTERED_SCHEDULER_TASK_NAMES) {
      const tables = tablesForSchedulerTask(task);
      assertSchedulerTableDeclarations([
        { id: task, tables: { reads: tables, writes: [] } },
      ]);
    }
    expect(() => tablesForSchedulerTask("fixture.unregisteredTask")).toThrow(
      "Scheduler task fixture.unregisteredTask has no table declaration",
    );
  });
});
