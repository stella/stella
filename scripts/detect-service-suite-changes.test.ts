import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  planServiceSuites,
  requiresServiceSuites,
  serviceSuiteDependencies,
} from "./detect-service-suite-changes";
import { GENERATORS } from "./generated-files";

// The detector and the modules it imports, copied into fixture checkouts.
const DETECTOR_SOURCES = Object.fromEntries(
  [
    "../packages/scripts/src/generated-files.ts",
    "detect-service-suite-changes.ts",
    "generated-files.ts",
    "baseline-paths.ts",
  ].map((file) => [
    path.posix.normalize(`scripts/${file}`),
    readFileSync(new URL(file, import.meta.url), "utf-8"),
  ]),
);

test("database, migrations, scheduler, backfills, suites, and harness changes require service suites", () => {
  for (const file of [
    "apps/api/src/db/schema/new.ts",
    "apps/api/drizzle/123_new.sql",
    "apps/api/src/lib/scheduler/new.ts",
    "apps/api/src/handlers/legislation/new-backfill.ts",
    "apps/api/src/scripts/new.ts",
    "apps/api/src/tests/setup-env.ts",
    "apps/api/src/removed-suite.test.ts",
    "apps/api/src/lib/file-scan/yara/office-macros.yar",
    "apps/collab/src/server.test.ts",
    "bun.lock",
    "patches/new.patch",
    ".github/workflows/ci.yml",
  ]) {
    expect(requiresServiceSuites([file]), file).toBe(true);
  }
});

test("service-suite import closure covers every discovered dependency and leaves unrelated changes unplanned", () => {
  const graph = serviceSuiteDependencies();
  if (graph.status !== "complete") {
    throw new TypeError(graph.message);
  }
  const { dependencies, packageScopes } = graph;
  expect(dependencies.size).toBeGreaterThan(50);
  expect(packageScopes.size).toBeGreaterThan(0);
  // Every discovered dependency must reach the production selector individually.
  for (const file of dependencies) {
    expect(requiresServiceSuites([file]), file).toBe(true);
  }
  for (const file of [
    "docs/guide.md",
    "apps/web/src/page.tsx",
    "apps/landing/src/page.astro",
    "apps/api/src/unused-new-handler.ts",
    "packages/unused-new-package/src/file.ts",
  ]) {
    expect(requiresServiceSuites([file]), file).toBe(false);
  }
});

test("a derived module is followed through its generator inputs, never its ignored output", () => {
  const graph = serviceSuiteDependencies();
  if (graph.status !== "complete") {
    throw new TypeError(graph.message);
  }
  const runtime = GENERATORS.find(({ id }) => id === "capability-runtime");
  if (runtime === undefined) {
    throw new TypeError(
      "the generator manifest has no capability-runtime entry",
    );
  }
  for (const output of runtime.outputs) {
    expect(graph.dependencies.has(output), output).toBe(false);
  }
  expect(graph.dependencies).toContain(
    "apps/api/scripts/generate-capability-runtime.ts",
  );
  expect(
    [...graph.dependencies].some((file) =>
      file.startsWith("packages/cli/capabilities/"),
    ),
  ).toBe(true);
});

test("a newly added transitive import is picked up without editing the detector", () => {
  const root = mkdtempSync(path.join(tmpdir(), "service-suite-graph-"));
  const sources = {
    ...DETECTOR_SOURCES,
    "apps/api/package.json": readFileSync(
      new URL("../apps/api/package.json", import.meta.url),
      "utf-8",
    ),
    "apps/api/src/tests/setup-env.ts": "",
    "apps/api/scripts/run-postgres-tests.ts": "",
    "apps/api/scripts/run-valkey-tests.ts": "",
    "apps/api/src/db/migrate.ts": "",
    "apps/collab/src/server.test.ts": "",
    "apps/api/src/gated.test.ts":
      'const gate = "STELLA_RUN_POSTGRES_TESTS"; import "./first";',
    "apps/api/src/first.ts": 'import("@/api/second"); require("./required");',
    "apps/api/src/required.ts": "export const value = 1;",
    "apps/api/src/second.ts": 'import "@stll/example";',
    "packages/example/package.json":
      '{"name":"@stll/example","dependencies":{"@stll/second":"workspace:*"}}',
    "packages/second/package.json":
      '{"name":"@stll/second","dependencies":{"@stll/example":"workspace:*"}}',
    "packages/example/src/index.ts": "export const value = 1;",
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    for (const file of [
      "apps/api/src/first.ts",
      "apps/api/src/required.ts",
      "apps/api/src/second.ts",
      "packages/example/src/new.ts",
      "packages/example/data/asset.json",
      "packages/second/src/new.ts",
    ]) {
      expect(requiresServiceSuites([file], root), file).toBe(true);
    }
    expect(requiresServiceSuites(["apps/api/src/third.ts"], root)).toBe(false);
    writeFileSync(
      path.join(root, "apps/api/src/second.ts"),
      'export { value } from "./third.js";',
    );
    writeFileSync(
      path.join(root, "apps/api/src/third.ts"),
      "export const value = 2;",
    );
    expect(requiresServiceSuites(["apps/api/src/third.ts"], root)).toBe(true);
    const graph = serviceSuiteDependencies(root);
    expect(graph.status).toBe("complete");
    if (graph.status !== "complete") {
      throw new TypeError(graph.message);
    }
    expect(graph.dependencies).toContain("apps/api/src/third.ts");
    writeFileSync(
      path.join(root, "apps/api/src/second.ts"),
      'import "./missing";',
    );
    expect(requiresServiceSuites(["apps/api/src/third.ts"], root)).toBe(true);
    const cli = Bun.spawnSync(
      [
        process.execPath,
        path.join(root, "scripts/detect-service-suite-changes.ts"),
        "apps/api/src/third.ts",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(cli.exitCode).toBe(0);
    expect(new TextDecoder().decode(cli.stdout).trim()).toBe("true");
    expect(new TextDecoder().decode(cli.stderr)).toContain(
      "Unresolved service-suite import",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each suite follows its own import closure without planning unrelated siblings", () => {
  const root = mkdtempSync(path.join(tmpdir(), "service-suite-scopes-"));
  const sources = {
    "apps/api/package.json": readFileSync(
      new URL("../apps/api/package.json", import.meta.url),
      "utf-8",
    ),
    "apps/api/src/tests/setup-env.ts": "",
    "apps/api/src/db/migrate.ts": "",
    "apps/api/scripts/run-postgres-tests.ts": "",
    "apps/api/scripts/run-valkey-tests.ts": "",
    "apps/api/src/postgres.test.ts":
      'const gate = "STELLA_RUN_POSTGRES_TESTS"; import "./postgres-only";',
    "apps/api/src/corpus.test.ts":
      'const gate = "STELLA_RUN_CORPUS_ENGINE_TESTS"; import "./corpus-only";',
    "apps/api/src/valkey.test.ts":
      'const gate = "STELLA_RUN_VALKEY_TESTS"; import "./valkey-only";',
    "apps/api/src/postgres-only.ts": "",
    "apps/api/src/corpus-only.ts": "",
    "apps/api/src/valkey-only.ts": "",
    "apps/collab/src/server.test.ts": 'import "@stll/collaboration-only";',
    "packages/collaboration-only/package.json":
      '{"name":"@stll/collaboration-only"}',
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    for (const [suite, file] of [
      ["postgres", "apps/api/src/postgres-only.ts"],
      ["corpus", "apps/api/src/corpus-only.ts"],
      ["valkey", "apps/api/src/valkey-only.ts"],
      ["collab", "packages/collaboration-only/src/new.ts"],
    ] as const) {
      expect(planServiceSuites([file], root), file).toEqual({
        postgres: suite === "postgres",
        corpus: suite === "corpus",
        valkey: suite === "valkey",
        collab: suite === "collab",
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removed runner metadata widens the detector inside its guarded execution", () => {
  const root = mkdtempSync(path.join(tmpdir(), "service-runner-metadata-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "apps/api"), { recursive: true });
    for (const [file, source] of Object.entries(DETECTOR_SOURCES)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    for (const metadata of [
      {},
      { ciGateTestRunners: { "test:renamed": {} } },
      { ciGateTestRunners: { "test:postgres": { gate: null } } },
    ]) {
      writeFileSync(
        path.join(root, "apps/api/package.json"),
        JSON.stringify(metadata),
      );
      const result = Bun.spawnSync(
        [
          process.execPath,
          path.join(root, "scripts/detect-service-suite-changes.ts"),
          "--scopes",
          "docs/guide.md",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout).trim()).toBe(
        "true true true true",
      );
      expect(new TextDecoder().decode(result.stderr)).toContain(
        "Missing or invalid API service test runner metadata",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
