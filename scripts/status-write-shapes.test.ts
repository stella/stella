import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { STATUS_TRANSITION_OWNERSHIP } from "./ownership";
import {
  assessMeasurements,
  openSourceTree,
  RATCHET_METRICS,
  scanTree,
} from "./ratchet";
import {
  countUnmanagedTransitionSpecs,
  unmanagedTransitionTables,
  statusWriteCalls,
} from "./status-write-shapes";

const columns = STATUS_TRANSITION_OWNERSHIP.enforcement.columns;
const measure = (content: string) =>
  statusWriteCalls({ content, file: "writer.ts", columns }).length;

describe("lifecycle write shapes", () => {
  test("import forms cannot hide opaque lifecycle table handles", () => {
    for (const declaration of [
      'import rows from "./table-facade";',
      'import rows, { other } from "./table-facade";',
      'import { table as rows } from "./table-facade";',
      'import rows = require("./table-facade");',
      "import rows = facade.table;",
    ]) {
      for (const [table, keys] of Object.entries(columns)) {
        for (const key of keys) {
          const content = `${declaration}\nconst handle = rows; db.update(handle).set({ ${key}: "running" });`;
          expect({ declaration, table, key, count: measure(content) }).toEqual({
            declaration,
            table,
            key,
            count: 1,
          });
        }
      }
    }
  });
  test("the syntactic class covers every declared lifecycle column and each static property spelling", () => {
    for (const [table, keys] of Object.entries(columns)) {
      for (const key of keys) {
        for (const spelling of [
          key,
          `"${key}"`,
          `["${key}"]`,
          `[\`${key}\`]`,
        ]) {
          expect(
            measure(
              `db.update(${table}).set({ ${spelling}: "running" }).where(eq(id));`,
            ),
          ).toBe(1);
        }
      }
    }
  });
  test("comments, strings, inserts and unrelated table or column writes are not updates", () => {
    expect(
      measure(
        'const text = "db.update(flowRuns).set({ status: running })"; // db.update(flowRuns).set({status: "running"})\ndb.insert(flowRuns).values({ status: "running" }); db.update(users).set({ status: "active" }); db.update(flowRuns).set({ label: "Running" });',
      ),
    ).toBe(0);
  });
  test("optional and computed method calls are still writes", () => {
    expect(
      measure(
        'db?.update(flowRuns)?.set({ status: "running" }); db["update"](flowRuns)["set"]({ status: "failed" });',
      ),
    ).toBe(2);
  });
  test("opaque table/payload handles, conflict writes and explicit payload mutations are measured", () => {
    for (const content of [
      'function apply(table) { db.update(table).set({ status: "running" }); }',
      'import { rows } from "./table-facade"; db.update(rows).set({ status: "running" });',
      'db.insert(flowRuns).values(row).onConflictDoUpdate({ target: flowRuns.id, set: { status: "running" } });',
      'db.update(flowRuns).set(flag ? { status: "running" } : { label: "done" });',
      'db.update(flowRuns).set({ ...(flag && { status: "running" }) });',
      "db.update(flowRuns).set({ ...opaque });",
      "db.update(flowRuns).set(makePatch());",
      'const patch = {}; patch.status = "running"; db.update(flowRuns).set(patch);',
      'const patch = {}; const alias = patch; alias["status"] = "running"; db.update(flowRuns).set(patch);',
      'let patch = {}; patch = { status: "running" }; db.update(flowRuns).set(patch);',
      'const patch = {}; Object.assign(patch, { status: "running" }); db.update(flowRuns).set(patch);',
      'const patch = {}; Reflect.set(patch, key, "running"); db.update(flowRuns).set(patch);',
    ]) {
      expect({ content, count: measure(content) }).toEqual({
        content,
        count: 1,
      });
    }
  });
  test("static SQL lifecycle updates are measured through quoted names, SQL aliases and tuple assignments", () => {
    for (const content of [
      `tx.execute(sql\`UPDATE flow_runs SET status = \${value} WHERE id = \${id}\`);`,
      `tx.execute(sql\`UPDATE \${flowRuns} SET \${flowRuns.status} = \${value}\`);`,
      `tx.execute(raw\`UPDATE "flow_runs" SET "status" = \${value}\`);`,
      "tx.execute(sql.raw(\"UPDATE flow_runs SET updated_at = now(), status = 'running' WHERE id = 'job'\"));",
      `tx.execute(sql\`UPDATE unknown_table SET item_status = \${value}\`);`,
      `tx.execute(sql\`UPDATE flow_runs SET (status, error) = (\${value}, NULL)\`);`,
      `tx.execute(sql\`UPDATE flow_runs SET ("status", "error") = (\${value}, NULL)\`);`,
      'tx.execute("UPDATE flow_runs " + "SET status = $1 WHERE id = $2");',
    ]) {
      expect({ content, count: measure(content) }).toEqual({
        content,
        count: 1,
      });
    }
    expect(
      measure(
        `tx.execute(sql\`UPDATE flow_runs SET error = \${value} WHERE status = 'running'\`); // UPDATE flow_runs SET status = running`,
      ),
    ).toBe(0);
  });
  test("external SQL builders and external payload mutation remain outside static inspection while visible statements count independently", () => {
    expect(
      measure(
        'import { decorate } from "external-mutator"; const patch = {}; decorate(patch); db.update(flowRuns).set(patch);',
      ),
    ).toBe(0);
    expect(
      measure(
        `tx.execute(sql\`UPDATE mapped_jobs SET lifecycle_code = \${next}\`);`,
      ),
    ).toBe(0);
    expect(
      measure(
        'import { buildUpdate } from "external-sql"; tx.execute(buildUpdate(table, values));',
      ),
    ).toBe(0);
    expect(
      measure(
        `tx.execute(sql\`UPDATE flow_runs SET status = \${first}; UPDATE flow_run_steps SET status = \${second}\`);`,
      ),
    ).toBe(2);
  });
  test("unmanaged reasons count as properties rather than occurrences of the word", () => {
    expect(
      countUnmanagedTransitionSpecs(
        'const unmanaged = "reason"; export const TRANSITIONS = { jobs: { unmanaged }, runs: { "unmanaged": "reason" }, other: defineTransitions(table, { done: [] }, { terminal: ["done"] }) }; // unmanaged',
      ),
    ).toBe(2);
  });
  test("unmanaged declarations retain actual table identities through object aliases and spreads", () => {
    expect(
      unmanagedTransitionTables(
        'const legacy = { unmanaged: "reason" }; const entries = { jobs: legacy, "runs": { ...legacy } }; export const TRANSITIONS = { ...entries, managed: defineTransitions(table, graph, options) } as const satisfies Specs;',
      ),
    ).toEqual(["jobs", "runs"]);
    expect(() =>
      unmanagedTransitionTables('export { TRANSITIONS } from "./elsewhere";'),
    ).toThrow("statically readable TRANSITIONS");
  });
  test("scoped transition state columns enter direct-write enforcement from the canonical registry", () => {
    expect(columns["contacts"]).toContain("sanctionsMonitoringMode");
    expect(columns["organizationSettings"]).toContain(
      "sanctionsMonitoringMode",
    );
    expect(columns["sanctionsContactMatches"]).toEqual([
      "disposition",
      "state",
    ]);
    expect(columns["sanctionsContactScreenings"]).toContain("status");
    const guardedFields = [
      { table: "contacts", column: "sanctionsMonitoringMode" },
      { table: "organizationSettings", column: "sanctionsMonitoringMode" },
      { table: "sanctionsContactMatches", column: "disposition" },
    ] as const;
    for (const { table, column } of guardedFields) {
      expect(
        measure(`db.update(${table}).set({ ${column}: "changed" });`),
      ).toBe(1);
    }
    const registry = readFileSync(
      new URL("../apps/api/src/lib/db/transition-specs.ts", import.meta.url),
      "utf-8",
    );
    expect(
      unmanagedTransitionTables(registry).filter((table) =>
        [
          "contacts",
          "organizationSettings",
          "sanctionsContactMatches",
          "sanctionsContactScreenings",
        ].includes(table),
      ),
    ).toEqual([]);
  });
});

describe("lifecycle ratchets", () => {
  test("direct writes cannot be relocated or grow within an existing caller", () => {
    const metrics = RATCHET_METRICS.filter(
      ({ id }) => id === "direct-status-writes",
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.growth).toBe("shrink-only");
    const baseline = {
      "direct-status-writes": { count: 2, files: { "apps/api/src/old.ts": 2 } },
    };
    for (const current of [
      {
        count: 2,
        files: { "apps/api/src/old.ts": 1, "apps/api/src/new.ts": 1 },
      },
      { count: 3, files: { "apps/api/src/old.ts": 3 } },
    ]) {
      expect(
        assessMeasurements({
          metrics,
          baseline,
          current: { "direct-status-writes": current },
        }).allowed,
      ).toBe(false);
    }
  });
  test("absent specs begin unmanaged, and declaring managed specs shrinks that debt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "status-ratchet-"));
    const metrics = RATCHET_METRICS.filter(
      ({ id }) => id === "unmanaged-transition-specs",
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.growth).toBe("shrink-only");
    try {
      const base = scanTree({ tree: openSourceTree(root), metrics }).snapshot;
      expect(base["unmanaged-transition-specs"]?.count).toBeGreaterThan(1);
      const file = path.join(root, "apps/api/src/lib/db/transition-specs.ts");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        'export const TRANSITIONS = { flowRuns: { unmanaged: "pending migration" } };',
      );
      const current = scanTree({
        tree: openSourceTree(root),
        metrics,
      }).snapshot;
      expect(current["unmanaged-transition-specs"]?.count).toBe(1);
      expect(current["unmanaged-transition-specs"]?.files).toEqual({
        "apps/api/src/lib/db/transition-specs.ts#flowRuns": 1,
      });
      expect(
        assessMeasurements({ metrics, baseline: base, current }).allowed,
      ).toBe(true);
      expect(
        assessMeasurements({ metrics, baseline: current, current: base })
          .allowed,
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("managing one table cannot fund reopening another or adding a new unmanaged entry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "status-member-ratchet-"));
    const metrics = RATCHET_METRICS.filter(
      ({ id }) => id === "unmanaged-transition-specs",
    );
    const file = path.join(root, "apps/api/src/lib/db/transition-specs.ts");
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        'export const TRANSITIONS = { flowRuns: managedSpec, flowRunSteps: { unmanaged: "legacy" } };',
      );
      const baseline = scanTree({
        tree: openSourceTree(root),
        metrics,
      }).snapshot;
      for (const table of ["flowRuns", "newStatusTable"]) {
        writeFileSync(
          file,
          `export const TRANSITIONS = { flowRunSteps: managedSpec, ${table}: { unmanaged: "reason" } };`,
        );
        const current = scanTree({
          tree: openSourceTree(root),
          metrics,
        }).snapshot;
        expect(current["unmanaged-transition-specs"]?.count).toBe(
          baseline["unmanaged-transition-specs"]?.count,
        );
        const assessment = assessMeasurements({ metrics, baseline, current });
        expect(assessment.allowed).toBe(false);
        expect(assessment.diffs[0]?.regressedFiles).toEqual([
          {
            file: `apps/api/src/lib/db/transition-specs.ts#${table}`,
            from: 0,
            to: 1,
          },
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
