import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assessMeasurements,
  openSourceTree,
  RATCHET_METRICS,
  type RatchetMetric,
  scanTree,
  selectMetricFiles,
} from "./ratchet";

const ROOT = path.resolve(import.meta.dir, "..");

// What a metric scanned before the walk was shared: its own globs, walked
// fresh, each match once, minus its excludes.
const ownSelection = (
  metric: Extract<RatchetMetric, { scope: "file" }>,
): string[] => {
  const seen = new Set<string>();
  for (const glob of metric.include) {
    for (const rel of new Bun.Glob(glob).scanSync(ROOT)) {
      seen.add(rel);
    }
  }
  return [...seen].filter((rel) => !metric.exclude(rel)).toSorted();
};

type OrgWriteGraphFixtureOptions = {
  sources: Readonly<Record<string, string>>;
  entryFiles: readonly string[];
  orgTables: Readonly<Record<string, string>>;
  globalTables: Readonly<Record<string, string>>;
};

const seedOrgWriteGraphFixture = (
  root: string,
  { sources, entryFiles, orgTables, globalTables }: OrgWriteGraphFixtureOptions,
): void => {
  const recoveryPrefix = "apps/api/src/lib/db/recovery-bookkeeping/";
  const classes = Object.keys(sources)
    .filter((file) => file.startsWith(recoveryPrefix))
    .map((file) => file.slice(recoveryPrefix.length, -".ts".length));
  const tables = { ...orgTables, ...globalTables };
  const declarations = Object.entries(tables).map(
    ([name, relation]) =>
      `export const ${name} = pgTable(${JSON.stringify(relation)}, { id: text("id"), organizationId: text("organization_id") });`,
  );
  const registry = (registryTables: Readonly<Record<string, string>>) =>
    Object.keys(registryTables)
      .map((name) => `${name}: { table: ${name} }`)
      .join(", ");
  const fixtureSources = {
    "apps/api/src/db/root.ts": "export const rootDb = {};",
    "apps/api/src/db/org-scope.ts": "export const withOrgScope = () => {};",
    "apps/api/src/db/schema.ts": [
      'import { pgTable, text } from "drizzle-orm/pg-core";',
      ...declarations,
    ].join("\n"),
    "apps/api/src/db/org-scope-registry.ts": [
      `import { ${Object.keys(tables).join(", ")} } from "./schema";`,
      `export const ORG_SCOPE_TABLES = { ${registry(orgTables)} };`,
      `export const GLOBAL_SCOPE_TABLES = { ${registry(globalTables)} };`,
    ].join("\n"),
    "scripts/ownership/org-writer-fixture.ts": `export default {
      id: "org-writer-fixture",
      group: "root-connection",
      owner: ${JSON.stringify(entryFiles)},
    };`,
    "scripts/ownership/recovery-bookkeeping.ts": [
      `const CLASSES = ${JSON.stringify(classes)} as const;`,
      `export default { id: "recovery-bookkeeping", owner: CLASSES.map((kind) => \`apps/api/src/lib/db/recovery-bookkeeping/\${kind}.ts\`) };`,
    ].join("\n"),
    ...sources,
  };
  for (const [file, content] of Object.entries(fixtureSources)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
};

describe("shared ratchet scan", () => {
  test("owner writer budgets remain independent per table and operation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-org-writers-"));
    const metric =
      RATCHET_METRICS.find(({ id }) => id === "unscoped-org-owner-writes") ??
      panic("Owner writer metric is missing");
    const owner = "apps/api/src/lib/flows/writer-fixture.ts";
    const measure = (
      table: string,
      operation: string,
      receiver = "ownerTx",
      value = 0,
    ) => {
      seedOrgWriteGraphFixture(root, {
        sources: {
          [owner]: [
            'import { rootDb as ownerTx } from "@/api/db/root";',
            'import { eq } from "drizzle-orm";',
            'import { flowRuns, signals } from "@/api/db/schema";',
            'import { withOrgScope } from "@/api/db/org-scope";',
            `withOrgScope({ tx: ownerTx, scope, actor: { type: "system" }, fn: (scopedTx) => ${receiver}.${operation}(${table}).where(eq(${table}.id, ${value})) });`,
          ].join("\n"),
        },
        entryFiles: [owner],
        orgTables: { flowRuns: "flow_runs", signals: "signals" },
        globalTables: {},
      });
      return scanTree({ tree: openSourceTree(root), metrics: [metric] })
        .snapshot;
    };
    try {
      const baseline = measure("flowRuns", "update");
      const budget =
        baseline[metric.id] ?? panic("Owner writer fixture budget is missing");
      expect(budget.count).toBe(1);
      expect(Object.keys(budget.files)).toHaveLength(1);
      expect(
        Object.keys(budget.files)
          .at(0)
          ?.startsWith(`${owner}#flowRuns#update#`),
      ).toBe(true);
      const assess = (
        table: string,
        operation: string,
        receiver?: string,
        value?: number,
      ) =>
        assessMeasurements({
          current: measure(table, operation, receiver, value),
          baseline,
          metrics: [metric],
        });
      expect(assess("flowRuns", "update").allowed).toBe(true);
      expect(assess("flowRuns", "update", "scopedTx").allowed).toBe(true);
      expect(assess("signals", "update").allowed).toBe(false);
      expect(assess("flowRuns", "delete").allowed).toBe(false);
      expect(assess("flowRuns", "update", "ownerTx", 1).allowed).toBe(false);
      expect(metric.growth).toBe("shrink-only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("delegated organization writer coverage", () => {
    const entry = "apps/api/src/lib/flows/delegated-writer-fixture.ts";
    const rootWriter = "apps/api/src/lib/other/root-writer.ts";
    const claims = "apps/api/src/lib/db/recovery-bookkeeping/claims.ts";
    const receipts = "apps/api/src/lib/db/recovery-bookkeeping/receipts.ts";
    const imports = [
      'import { flowUploadTriggerIntents } from "@/api/db/schema";',
      'import { withOrgScope } from "@/api/db/org-scope";',
    ].join("\n");
    const claimBody = `
      export const mutateRecoveryClaim = async (op) => {
        switch (op.type) {
          case "upload-defer":
            await op.tx.update(op.table).set({ retryAt: op.retryAt }).where(op.where);
            return;
          default: throw new Error("Unexpected fixture operation");
        }
      };
    `;
    const measure = (
      sources: Readonly<Record<string, string>>,
      entryFiles: readonly string[] = [entry],
    ) => {
      const root = mkdtempSync(path.join(tmpdir(), "ratchet-delegated-org-"));
      const metric =
        RATCHET_METRICS.find(({ id }) => id === "unscoped-org-owner-writes") ??
        panic("Owner writer metric is missing");
      try {
        seedOrgWriteGraphFixture(root, {
          sources,
          entryFiles,
          orgTables: {
            flowUploadTriggerIntents: "flow_upload_trigger_intents",
            workspaceSearchDocuments: "workspace_search_documents",
          },
          globalTables: { schedulerJobs: "scheduler_jobs" },
        });
        return (
          scanTree({ tree: openSourceTree(root), metrics: [metric] }).snapshot[
            metric.id
          ] ?? panic("Delegated writer measurement is missing")
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    test("a root handle outside the old directory filter still enrolls its writes", () => {
      expect(
        measure(
          {
            [rootWriter]: `
          import { rootDb as owner } from "@/api/db/root";
          import { flowUploadTriggerIntents } from "@/api/db/schema";
          export const write = () => owner.update(flowUploadTriggerIntents).set({ status: "pending" });
        `,
            "apps/api/src/db/root.ts": "export const rootDb = {};",
          },
          [rootWriter],
        ).count,
      ).toBe(1);
    });

    test("moving the primitive into an op.table recovery helper cannot erase it", () => {
      const measured = measure({
        [entry]: `${imports}
          import { mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
          export const run = (ownerTx) => mutateRecoveryClaim({
            type: "upload-defer", tx: ownerTx, table: flowUploadTriggerIntents,
            retryAt: now, where: predicate,
          });`,
        [claims]: claimBody,
      });
      expect(measured.count).toBe(1);
      expect(Object.keys(measured.files)).toHaveLength(1);
      expect(Object.keys(measured.files).at(0)).toContain(
        "#flowUploadTriggerIntents#update#",
      );
    });

    test("named reexports, renamed imports and local helpers retain the write obligation", () => {
      expect(
        measure({
          [entry]: `${imports}
          import { deferred as write } from "../other/recovery-relay";
          const relay = (operation) => write(operation);
          export const run = (ownerTx) => relay({
            type: "upload-defer", tx: ownerTx, table: flowUploadTriggerIntents,
            retryAt: now, where: predicate,
          });`,
          "apps/api/src/lib/other/recovery-relay.ts":
            'export { mutateRecoveryClaim as deferred } from "@/api/lib/db/recovery-bookkeeping/claims";',
          [claims]: claimBody,
        }).count,
      ).toBe(1);
    });

    test.each(["scopedTx", "ownerTx"])(
      "nested helper callbacks preserve the actual %s receiver",
      (receiver) => {
        const measured = measure({
          [entry]: `${imports}
            import { through, mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
            export const run = (ownerTx) => withOrgScope({
              tx: ownerTx, scope, actor: { type: "system" },
              fn: async (scopedTx) => through({
                tx: ${receiver},
                fn: (writer) => mutateRecoveryClaim({
                  type: "upload-defer", tx: writer, table: flowUploadTriggerIntents,
                  retryAt: now, where: predicate,
                }),
              }),
            });`,
          [claims]: `${claimBody} export const through = (operation) => operation.fn(operation.tx);`,
        });
        expect(measured.count).toBe(receiver === "scopedTx" ? 0 : 1);
      },
    );

    test("parameterized lifecycle specs resolve to their actual organization table", () => {
      expect(
        measure({
          [entry]: `${imports}
          import { settle } from "@/api/lib/db/recovery-bookkeeping/receipts";
          const spec = { table: flowUploadTriggerIntents };
          export const run = (ownerTx) => settle({ tx: ownerTx, spec });`,
          [receipts]: `
          import { transitionScopedCount } from "@/api/lib/db/transitions";
          export const settle = (operation) => transitionScopedCount({
            tx: operation.tx, spec: operation.spec,
          });`,
          "apps/api/src/lib/db/transitions.ts": `
          export const transitionScopedCount = (options) =>
            options.tx.update(options.spec.table).set({ status: "pending" });`,
        }).count,
      ).toBe(1);
    });

    test("delegated raw SQL mutations remain counted", () => {
      expect(
        measure({
          [entry]: `import { writeSearchBookkeeping } from "@/api/lib/db/recovery-bookkeeping/search";
          export const run = (ownerTx) => writeSearchBookkeeping({ db: ownerTx });`,
          "apps/api/src/lib/db/recovery-bookkeeping/search.ts":
            'import { sql } from "drizzle-orm"; export const writeSearchBookkeeping = (operation) => operation.db.execute(sql`UPDATE workspace_search_documents SET updated_at = now()`);',
        }).count,
      ).toBe(1);
    });

    test("GLOBAL scheduler targets do not become organization writes", () => {
      expect(
        measure({
          [entry]: `import { schedulerJobs } from "@/api/db/schema";
          import { writeSchedulerBookkeeping } from "@/api/lib/db/recovery-bookkeeping/scheduler";
          export const run = (ownerTx) => writeSchedulerBookkeeping({ db: ownerTx, table: schedulerJobs });`,
          "apps/api/src/lib/db/recovery-bookkeeping/scheduler.ts":
            "export const writeSchedulerBookkeeping = (operation) => operation.db.update(operation.table).set({ enabled: false });",
        }).count,
      ).toBe(0);
    });

    test("unresolved writes reached from root cannot silently pass", () => {
      expect(() =>
        measure(
          {
            [rootWriter]: `
          import { rootDb } from "@/api/db/root";
          import { unknownTable } from "./missing-table";
          export const write = () => rootDb.update(unknownTable).set({ value: 1 });`,
            "apps/api/src/db/root.ts": "export const rootDb = {};",
          },
          [rootWriter],
        ),
      ).toThrow(/unresolved|missing source/iu);
    });
  });

  test("every file metric scans exactly the files its own globs select", () => {
    const tree = openSourceTree(ROOT);
    for (const metric of RATCHET_METRICS) {
      if (metric.scope !== "file") {
        continue;
      }
      expect({
        id: metric.id,
        files: selectMetricFiles(tree, metric).toSorted(),
      }).toEqual({ id: metric.id, files: ownSelection(metric) });
    }
  }, 30_000);

  test("indirect exception budgets reject new and relocated owners", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-indirect-"));
    const metric =
      RATCHET_METRICS.find(
        ({ id }) => id === "outbound-indirect-access-exceptions",
      ) ?? panic("Indirect exception metric is missing");
    const owner = "apps/web/src/runtime.ts";
    const written = new Set<string>();
    const measure = (owners: readonly string[]) => {
      for (const file of written) {
        rmSync(path.join(root, file));
      }
      written.clear();
      for (const file of owners) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "void import(mod);");
        written.add(file);
      }
      return scanTree({ tree: openSourceTree(root), metrics: [metric] })
        .snapshot;
    };
    try {
      expect(metric.growth).toBe("shrink-only");
      expect(metric.perFile).toBe(true);
      const baseline = measure([owner]);
      expect(baseline[metric.id]).toEqual({ count: 1, files: { [owner]: 1 } });
      const assess = (owners: readonly string[]) =>
        assessMeasurements({
          current: measure(owners),
          baseline,
          metrics: [metric],
        });
      expect(assess([owner]).allowed).toBe(true);
      expect(assess([]).allowed).toBe(true);
      expect(assess(["apps/web/src/other.ts"]).allowed).toBe(false);
      expect(assess([owner, "apps/web/src/other.ts"]).allowed).toBe(false);
      expect(measure(["apps/web/src/fixture.test.ts"])[metric.id]).toEqual({
        count: 0,
        files: {},
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the unclassified handler failure census counts only ungraded 5xx constructions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-unclassified-"));
    const file = "apps/api/src/handlers/fixture.ts";
    const metric =
      RATCHET_METRICS.find(
        ({ id }) => id === "unclassified-handler-failures",
      ) ?? panic("Unclassified handler failure metric is missing");
    try {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(
        path.join(root, file),
        [
          'new HandlerError({ status: 500, message: "a" });',
          'new HandlerError({ status: ok ? 404 : 503, message: "b" });',
          'new HandlerError({ status: 502, code: "unknown", message: "c" });',
          'new HandlerError({ status: 503, code: "upstream_unavailable", message: "d" });',
          'classifyFailure(new HandlerError({ status: 500, message: "e" }), "rls_denied");',
          'new HandlerError({ status: 404, message: "f" });',
          'new HandlerError({ status, message: "g" });',
        ].join("\n"),
      );
      expect(
        scanTree({ tree: openSourceTree(root), metrics: [metric] }).snapshot[
          metric.id
        ],
      ).toEqual({ count: 3, files: { [file]: 3 } });
      expect(metric.perFile).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("counters parse through the shared per-file memo", async () => {
    const counters = await Bun.file(
      path.join(ROOT, "scripts/ratchet.ts"),
    ).text();
    expect(counters).not.toContain("ts.createSourceFile(");
  });

  test("a .ts generic arrow cannot hide subsequent audit directives", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-dialect-"));
    const file = "apps/api/src/handlers/generic.ts";
    try {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(
        path.join(root, file),
        [
          "const identity = <T>(value: T) => value;",
          "// audit: skip - after a generic arrow",
        ].join("\n"),
      );
      const metrics = RATCHET_METRICS.filter(
        ({ id }) => id === "audit-skip-directives",
      );
      expect(
        scanTree({ tree: openSourceTree(root), metrics }).snapshot[
          "audit-skip-directives"
        ]?.files,
      ).toEqual({ [file]: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a quote inside a comment cannot hide the code after it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-comment-quote-"));
    const file = "apps/api/src/handlers/comment-quote.ts";
    try {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(
        path.join(root, file),
        [
          "// the model's reply",
          "const a = input ?? [];",
          "/** Pass `items once. */",
          "const b = items ?? [];",
          "const url = 'http://x/?? []'; const c = more ?? []; // it's done",
          "/* a ` b */ const d = rest ?? [];",
        ].join("\n"),
      );
      const metrics = RATCHET_METRICS.filter(
        ({ id }) => id === "nullish-array-fallback",
      );
      expect(
        scanTree({ tree: openSourceTree(root), metrics }).snapshot[
          "nullish-array-fallback"
        ]?.files,
      ).toEqual({ [file]: 4 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an earlier scan's counts carry over only for identical text", () => {
    const metrics = RATCHET_METRICS.filter(({ id }) => id === "as-casts");
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-scan-"));
    const source = (relative: string, contents: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), contents);
    };
    const kept = "apps/api/src/kept.ts";
    const edited = "apps/api/src/edited.ts";
    try {
      source(kept, "export const a = b as A;\n");
      source(edited, "export const c = d as C;\n");
      const first = scanTree({ tree: openSourceTree(root), metrics });

      source(edited, "export const c = d as C;\nexport const e = f as E;\n");
      const fresh = scanTree({ tree: openSourceTree(root), metrics });
      const reused = scanTree({
        tree: openSourceTree(root),
        metrics,
        previous: first,
      });
      expect(reused.snapshot).toEqual(fresh.snapshot);
      expect(fresh.snapshot["as-casts"]?.files).toEqual({
        [edited]: 2,
        [kept]: 1,
      });

      // Counts recorded for the same text are trusted as they stand, which is
      // what makes them reusable; counts for other text never are.
      const keptContent =
        first.files.get(kept)?.content ?? panic("kept file was not scanned");
      const poisoned = scanTree({
        tree: openSourceTree(root),
        metrics,
        previous: {
          snapshot: {},
          role: "head",
          files: new Map([
            [
              kept,
              { content: keptContent, counts: new Map([["as-casts", 5]]) },
            ],
            [edited, { content: "", counts: new Map([["as-casts", 9]]) }],
          ]),
        },
      });
      expect(poisoned.snapshot["as-casts"]?.files).toEqual({
        [edited]: 2,
        [kept]: 5,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reuse preserves measurement roles and recomputes repository interactions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-role-reuse-"));
    const kept = "kept.ts";
    const added = "added.ts";
    let fileCalls = 0;
    let roleCalls = 0;
    let repoCalls = 0;
    const metrics = [
      {
        scope: "file",
        id: "independent",
        description: "Fixture occurrence count",
        include: ["*.ts"],
        exclude: () => false,
        count: (content: string) => {
          fileCalls += 1;
          return content.length;
        },
      },
      {
        scope: "file",
        id: "nonpositive",
        description: "Fixture excluded occurrence count",
        include: ["*.ts"],
        exclude: () => false,
        count: () => -1,
      },
      {
        scope: "file",
        id: "sensitive",
        description: "Fixture role count",
        measurement: "role-sensitive",
        include: ["*.ts"],
        exclude: () => false,
        count: (_content, { role }) => {
          roleCalls += 1;
          return role === "head" ? 1 : 2;
        },
      },
      {
        scope: "repo",
        id: "interactions",
        description: "Fixture file pair count",
        count: ({ root: directory }) => {
          repoCalls += 1;
          const size = [...new Bun.Glob("*.ts").scanSync(directory)].length;
          const count = size > 1 ? size : 0;
          return { count, files: count === 0 ? {} : { [kept]: count } };
        },
      },
    ] as const satisfies readonly RatchetMetric[];
    try {
      writeFileSync(path.join(root, kept), "x");
      const head = scanTree({ tree: openSourceTree(root), metrics });
      writeFileSync(path.join(root, added), "xx");
      const base = scanTree({
        tree: openSourceTree(root, { role: "base" }),
        metrics,
        previous: head,
      });
      expect(base.snapshot["nonpositive"]).toEqual({ count: 0, files: {} });
      expect(fileCalls).toBe(2);
      expect(roleCalls).toBe(3);
      expect(repoCalls).toBe(2);
      expect(base.snapshot["sensitive"]?.files).toEqual({
        [added]: 2,
        [kept]: 2,
      });
      expect(base.snapshot["interactions"]?.count).toBe(2);
      expect(base.snapshot).toEqual(
        scanTree({ tree: openSourceTree(root, { role: "base" }), metrics })
          .snapshot,
      );
      const tracked = scanTree({
        tree: openSourceTree(root, { trackedFiles: new Set([kept]) }),
        metrics: metrics.filter(({ scope }) => scope === "file"),
        previous: base,
      });
      expect(tracked.snapshot["independent"]?.files).toEqual({ [kept]: 1 });
      expect(tracked.snapshot["sensitive"]?.files).toEqual({ [kept]: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("outbound transport identities only shrink within each owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-outbound-owner-"));
  const file = "apps/api/src/handlers/transport-owner.ts";
  const metrics = RATCHET_METRICS.filter(
    ({ id }) => id === "api-legacy-outbound-transports",
  );
  try {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const measure = (source: string) => {
      writeFileSync(path.join(root, file), source);
      return scanTree({ tree: openSourceTree(root), metrics }).snapshot;
    };
    const baseline = measure("void fetch(url);");
    expect(
      assessMeasurements({
        current: measure("void fetch(url);"),
        baseline,
        metrics,
      }).allowed,
    ).toBe(true);
    expect(
      assessMeasurements({
        current: measure("export const ready = true;"),
        baseline,
        metrics,
      }).allowed,
    ).toBe(true);
    for (const module of ["undici", "node:http", "node:https"]) {
      const current = measure(`import * as transport from "${module}";`);
      expect(assessMeasurements({ current, baseline, metrics }).allowed).toBe(
        false,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
