import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const ruleOptions = {
  owner: "apps/api/src/lib/db/transitions.ts",
  columns: {
    flowRuns: ["status"],
    requestJobs: ["state", "phase"],
    invitation: ["status"],
    agentRegistration: ["status"],
  },
};

test("default and import-equals handles reach the lifecycle ownership rule", async () => {
  const source = [
    'import rows from "./table-facade";',
    'import otherRows = require("./table-facade");',
    'import schema = require("@/api/db/schema");',
    'db.update(rows).set({ status: "running" });',
    'db.update(otherRows).set({ status: "running" });',
    'db.update(schema.flowRuns).set({ status: "running" });',
    'db.update(schema.users).set({ status: "active" });',
  ].join("\n");
  expect(
    await lintSingleRule("no-direct-status-set", source, { ruleOptions }),
  ).toEqual([4, 5, 6]);
});
const writerSource = [
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
  test("reports lifecycle writes through aliases and opaque table parameters, preserving known non-lifecycle writes", async () => {
    expect(
      await lintSingleRule("no-direct-status-set", writerSource, {
        ruleOptions,
        sourcePath: "apps/api/src/lib/writer.ts",
      }),
    ).toEqual([3, 4, 7, 8, 9, 12]);
  });
  test("the owner can implement lifecycle writes", async () => {
    expect(
      await lintSingleRule("no-direct-status-set", writerSource, {
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
  test("agent-auth schema imports and re-exported table handles cannot hide lifecycle writes", async () => {
    const forwardedSource = [
      'import { agentRegistration } from "@/api/db/agent-auth-schema";',
      'import { jobs as forwarded } from "./reexported-tables";',
      'db.update(agentRegistration).set({ status: "active" });',
      'db.update(forwarded).set({ state: "running" });',
      'function write(table) { db.update(table).set({ status: "running" }); }',
    ].join("\n");
    expect(
      await lintSingleRule("no-direct-status-set", forwardedSource, {
        ruleOptions,
      }),
    ).toEqual([3, 4, 5]);
  });
  test("conflict updates, conditional and opaque spreads, and mutated payloads reach the guard", async () => {
    const conflictSource = [
      'import { flowRuns } from "@/api/db/schema";',
      'db.insert(flowRuns).values(row).onConflictDoUpdate({ target: flowRuns.id, set: { status: "running" } });',
      'db.update(flowRuns).set(ok ? { updatedAt: now } : { status: "failed" });',
      "db.update(flowRuns).set({ ...external });",
      "const patch = { updatedAt: now }; const alias = patch;",
      'alias.status = "running";',
      "db.update(flowRuns).set(patch);",
      'const assigned = {}; Object.assign(assigned, { status: "failed" });',
      "db.update(flowRuns).set(assigned);",
      'let reassigned = { updatedAt: now }; reassigned = { status: "failed" };',
      "db.update(flowRuns).set(reassigned);",
      "db.insert(flowRuns).values(row).onConflictDoUpdate({ target: flowRuns.id, set: { updatedAt: now } });",
    ].join("\n");
    expect(
      await lintSingleRule("no-direct-status-set", conflictSource, {
        ruleOptions,
      }),
    ).toEqual([2, 3, 4, 7, 9, 11]);
  });
  test("raw SQL status assignments are reported without conflating WHERE predicates with assignments", async () => {
    const sqlSource = [
      `db.execute(sql\`UPDATE flow_runs SET status = \${state} WHERE id = \${id}\`);`,
      "db.execute(sql.raw(\"UPDATE flow_runs SET error = NULL, status = 'failed' WHERE id = 'job'\"));",
      `db.execute(sql\`UPDATE \${table} SET \${column} = \${state} WHERE id = \${id}\`);`,
      `db.execute(sql\`UPDATE flow_runs SET error = \${message} WHERE status = 'failed'\`);`,
      "const harmless = \"SELECT 'UPDATE flow_runs SET status = running'\";",
    ].join("\n");
    expect(
      await lintSingleRule("no-direct-status-set", sqlSource, { ruleOptions }),
    ).toEqual([1, 2, 3]);
  });
});
