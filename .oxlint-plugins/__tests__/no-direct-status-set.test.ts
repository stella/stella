import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const ruleOptions = {
  owner: "apps/api/src/lib/db/transitions.ts",
  columns: {
    flowRuns: ["status"],
    requestJobs: ["state", "phase"],
    invitation: ["status"],
  },
};
const source = [
  'import { flowRuns as runs, requestJobs, users } from "@/api/db/schema";',
  'import * as schema from "@/api/db/schema/flows";',
  'db.update(runs).set({ status: "running" }).where(eq(runs.id, id));',
  'db.update(schema.flowRuns).set({ ["status"]: "running" });',
  'const changes = { status: "failed" };',
  "const table = runs;",
  "db.update(table).set({ ...changes, updatedAt: new Date() });",
  'db.update(requestJobs).set({ phase: "done" });',
  'db.update(requestJobs).set({ state: "done" });',
  "db.update(runs).set({ updatedAt: new Date() });",
  'db.update(users).set({ status: "active" });',
  'function shadow(runs) { db.update(runs).set({ status: "running" }); }',
].join("\n");

describe.serial("lifecycle write ownership", () => {
  test("reports status keys through schema and payload aliases, preserving non-lifecycle writes and shadowing", async () => {
    expect(
      await lintSingleRule("no-direct-status-set", source, {
        ruleOptions,
        sourcePath: "apps/api/src/lib/writer.ts",
      }),
    ).toEqual([3, 4, 7, 8, 9]);
  });
  test("the owner can implement lifecycle writes", async () => {
    expect(
      await lintSingleRule("no-direct-status-set", source, {
        ruleOptions,
        sourcePath: ruleOptions.owner,
      }),
    ).toEqual([]);
  });
  test("auth-schema tables and computed literal keys use the same guard", async () => {
    const authSource = [
      'import { invitation } from "@/api/db/auth-schema";',
      'import * as tables from "@/api/db/schema";',
      'const key = "status";',
      'db.update(invitation).set({ [key]: "accepted" });',
      'db.update(tables["flowRuns"]).set({ status: "running" });',
    ].join("\n");
    expect(
      await lintSingleRule("no-direct-status-set", authSource, { ruleOptions }),
    ).toEqual([4, 5]);
  });
});
