import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { queryPerfDependencies, queryPerfRequired } from "./query-perf-scope";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "query-perf-scope-"));
  roots.push(root);
  const registry = path.join(root, "apps/api/src/tests/query-perf");
  mkdirSync(registry, { recursive: true });
  writeFileSync(
    path.join(registry, "registry.ts"),
    'import { query } from\n  "../../lib/search/query";\nimport "@stll/scope-fixture";\nexport { query };',
  );
  mkdirSync(path.join(root, "apps/api/src/lib/search"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/api/src/lib/search/query.ts"),
    'import { helper } from "./helper";\nconst required = require("./required");\nexport { helper as query, required };',
  );
  writeFileSync(
    path.join(root, "apps/api/src/lib/search/helper.ts"),
    "export const helper = 1;",
  );
  writeFileSync(
    path.join(root, "apps/api/src/lib/search/required.ts"),
    "export const required = 1;",
  );
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query performance scope follows registry imports and database boundaries", () => {
  const root = fixture();
  const graph = queryPerfDependencies(root);
  expect(graph.status).toBe("complete");
  if (graph.status !== "complete") {
    return;
  }
  expect(graph.files).toEqual(
    new Set([
      "apps/api/src/tests/query-perf/registry.ts",
      "apps/api/src/lib/search/query.ts",
      "apps/api/src/lib/search/helper.ts",
      "apps/api/src/lib/search/required.ts",
    ]),
  );
  expect(
    queryPerfRequired(["apps/api/src/lib/search/helper.ts"], false, root),
  ).toBe(true);
  expect(
    queryPerfRequired(
      ["apps/api/drizzle/20261009_add_index/migration.sql"],
      false,
      root,
    ),
  ).toBe(true);
  expect(
    queryPerfRequired(
      ["apps/api/src/tests/query-perf/planner-settings.json"],
      false,
      root,
    ),
  ).toBe(true);
  expect(
    queryPerfRequired(
      ["apps/api/src/tests/gated-test-database.ts"],
      false,
      root,
    ),
  ).toBe(true);
  expect(
    queryPerfRequired(["apps/api/src/tests/explain-as-stella.ts"], false, root),
  ).toBe(true);
  expect(
    queryPerfRequired(["apps/api/scripts/run-perf-tests.ts"], false, root),
  ).toBe(true);
  expect(queryPerfRequired([".github/workflows/ci.yml"], false, root)).toBe(
    true,
  );
  expect(queryPerfRequired(["apps/api/package.json"], false, root)).toBe(true);
  expect(queryPerfRequired(["bun.lock"], false, root)).toBe(true);
  expect(
    queryPerfRequired(["packages/scope-fixture/src/index.ts"], false, root),
  ).toBe(true);
  expect(queryPerfRequired(["apps/web/src/page.tsx"], false, root)).toBe(false);
  expect(queryPerfRequired(["docs/query-perf-explainer.md"], false, root)).toBe(
    false,
  );
  expect(queryPerfRequired([], true, root)).toBe(true);
});

test("the real registry import closure resolves completely", () => {
  const graph = queryPerfDependencies();
  expect(graph.status).toBe("complete");
  if (graph.status !== "complete") {
    return;
  }
  expect(graph.files.has("apps/api/src/tests/query-perf/registry.ts")).toBe(
    true,
  );
  expect(
    graph.files.has("apps/api/src/lib/search/pg-fts-search-query.ts"),
  ).toBe(true);
  expect(
    queryPerfRequired(["apps/api/src/tests/query-perf/planner-settings.json"]),
  ).toBe(true);
});

test("an unknown full diff succeeds closed even without its path-list file", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", "scripts/query-perf-scope.ts"],
    env: {
      PATH: Bun.env["PATH"] ?? "",
      QUERY_PERF_CHANGED_PATHS: "/path/that/does/not/exist",
      QUERY_PERF_SCOPE_UNKNOWN: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("query_perf_required=true");
});

test("an unresolved registry dependency fails closed", () => {
  const root = fixture();
  writeFileSync(
    path.join(root, "apps/api/src/lib/search/query.ts"),
    'import "./missing";',
  );
  const graph = queryPerfDependencies(root);
  expect(graph.status).toBe("unresolved");
  expect(queryPerfRequired(["apps/web/src/page.tsx"], false, root)).toBe(true);
});
