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

import packageJson from "../apps/api/package.json" with { type: "json" };
import {
  listApiTestPaths,
  TEST_ROOTS,
} from "../apps/api/scripts/api-test-plan";
import { parseGatedTestSelection } from "../apps/api/scripts/gated-test-selection";
import { discoverGatedTestFiles } from "../apps/api/scripts/run-gated-tests";
import { API_ALL_RULES } from "./api-test-impact";
import {
  assertPostgresDiscovery,
  plannerSourceFiles,
  planPostgresTests,
  POSTGRES_NO_IMPACT_PATHS,
} from "./ci-postgres-test-plan";

const POSTGRES_GATE = "STELLA_RUN_POSTGRES_TESTS";
const API_TEST_FILE_GLOB = `{${TEST_ROOTS.join(",")}}/**/*.test.{ts,tsx}`;
const apiRoot = path.resolve(import.meta.dir, "../apps/api");

const withRepository = async (
  run: (
    root: string,
    write: (file: string, text: string) => void,
  ) => Promise<void>,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "postgres-plan-"));
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    write(
      "turbo.json",
      JSON.stringify({
        tasks: {
          "@stll/api#test": {
            inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/packages/example/src/**"],
          },
        },
      }),
    );
    write(
      "apps/api/package.json",
      JSON.stringify({
        name: "@stll/api",
        ciGateTestRunners: {
          "test:postgres": {
            gate: POSTGRES_GATE,
            testFileGlob: API_TEST_FILE_GLOB,
          },
        },
      }),
    );
    write("apps/api/src/tests/setup-env.ts", 'import "./preload-helper";');
    write("apps/api/src/tests/preload-helper.ts", "export const setup = true;");
    await run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const gateSource = (imports: string) =>
  `const enabled = process.env.${POSTGRES_GATE} === "true";\n${imports}\n`;

test("selects a two-hop gated database test and excludes unrelated gated tests", async () => {
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource('import "./entry";'));
    write(
      "apps/api/src/feature/entry.ts",
      'export { value } from "./nested/leaf";',
    );
    write("apps/api/src/feature/nested/leaf.ts", "export const value = true;");
    write(
      "apps/api/src/other.test.ts",
      gateSource('// import "./feature/entry";'),
    );
    const otherSource = readFileSync(
      path.join(root, "apps/api/src/other.test.ts"),
      "utf-8",
    );
    expect(otherSource).toBe(gateSource('// import "./feature/entry";'));
    expect(otherSource).not.toBe(gateSource('import "./feature/entry";'));

    expect(
      await planPostgresTests({
        event: "merge_group",
        scopeUnknown: false,
        changed: ["apps/api/src/feature/nested/leaf.ts"],
        root,
      }),
    ).toEqual({ mode: "selected", files: ["src/feature/db.test.ts"] });
  });
});

const allRuleCases = {
  manifest: "packages/example/package.json",
  lockfile: "bun.lock",
  typescript: "packages/example/tsconfig.build.json",
  bun: "apps/api/bunfig.toml",
  npm: ".npmrc",
  turbo: "turbo.json",
  patches: "patches/example.patch",
  github: ".github/workflows/ci.yml",
  migrations: "apps/api/drizzle/next/migration.sql",
  database: "apps/api/src/db/schema/table.ts",
  runner: "apps/api/scripts/run-tests.ts",
  selector: "scripts/api-test-impact.ts",
  environment: "apps/api/.env.example",
  postgres: "docker/postgres/init.sql",
  data: "packages/example/fixtures/example.html",
} satisfies Record<keyof typeof API_ALL_RULES, string>;

test("every API all-suite rule widens Postgres selection", async () => {
  expect(Object.keys(allRuleCases).toSorted()).toEqual(
    Object.keys(API_ALL_RULES).toSorted(),
  );
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource(""));
    for (const name of Object.keys(API_ALL_RULES)) {
      const rule = Reflect.get(API_ALL_RULES, name);
      const file: string = Reflect.get(allRuleCases, name);
      expect(rule.test(file), name).toBe(true);
      expect(
        await planPostgresTests({
          event: "merge_group",
          scopeUnknown: false,
          changed: [file],
          root,
        }),
        name,
      ).toEqual({ mode: "all" });
    }
  });
});

const noImpactCases = {
  changesets: [".changeset/quiet-cats.md"],
  agentInstructions: [
    ".agents/skills/example/SKILL.md",
    ".claude/skills/example/SKILL.md",
  ],
  cloudReport: ["CLOUD_REPORT.md"],
  repositoryTooling: ["scripts/unrelated-tool.test.ts"],
  documentation: ["docs/unread.md"],
} satisfies Record<keyof typeof POSTGRES_NO_IMPACT_PATHS, readonly string[]>;

test("named non-runtime paths select no Postgres suites alone or preserve source selection", async () => {
  expect(Object.keys(noImpactCases).toSorted()).toEqual(
    Object.keys(POSTGRES_NO_IMPACT_PATHS).toSorted(),
  );
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource('import "./entry";'));
    write("apps/api/src/feature/entry.ts", "export const value = true;");
    for (const name of Object.keys(POSTGRES_NO_IMPACT_PATHS)) {
      const files: readonly string[] = Reflect.get(noImpactCases, name);
      const policy = Reflect.get(POSTGRES_NO_IMPACT_PATHS, name);
      for (const file of files) {
        expect(policy.pattern.test(file), policy.reason).toBe(true);
        expect(
          await planPostgresTests({
            event: "pull_request",
            scopeUnknown: false,
            changed: [file],
            root,
          }),
          policy.reason,
        ).toEqual({ mode: "none" });
        expect(
          await planPostgresTests({
            event: "pull_request",
            scopeUnknown: false,
            changed: [file, "apps/api/src/feature/entry.ts"],
            root,
          }),
          policy.reason,
        ).toEqual({ mode: "selected", files: ["src/feature/db.test.ts"] });
      }
    }
  });
});

test("Postgres selection shares the narrowed GitHub reader boundary", async () => {
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource(""));
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/actions/ci-install/action.yml",
    ]) {
      expect(
        await planPostgresTests({
          event: "pull_request",
          scopeUnknown: false,
          changed: [file],
          root,
        }),
        file,
      ).toEqual({ mode: "all" });
    }
    for (const file of [
      ".github/workflows/pr-lint.yml",
      ".github/ci-event-policy.json",
      ".github/ci-checks/ci-checks-policy.yml",
    ]) {
      expect(
        await planPostgresTests({
          event: "pull_request",
          scopeUnknown: false,
          changed: [file],
          root,
        }),
        file,
      ).toEqual({ mode: "none" });
    }
  });
});

test("changes to the planner's own sources widen to all", async () => {
  const plannerFiles = plannerSourceFiles();
  // A helper reached only through the planner, and one reached through a
  // workspace package import.
  for (const file of [
    "scripts/ci-package-scope.ts",
    "packages/scripts/src/child-exit-status.ts",
  ]) {
    expect(plannerFiles.has(file), file).toBe(true);
  }
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource('import "./entry";'));
    write("apps/api/src/feature/entry.ts", "export const value = true;");
    expect(
      await planPostgresTests({
        event: "pull_request",
        scopeUnknown: false,
        changed: ["scripts/ci-package-scope.ts"],
        root,
      }),
    ).toEqual({ mode: "all" });
  });
});

test("unread documentation is ignored but documentation declared as an input widens", async () => {
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource(""));
    write(
      "scripts/docs-reader.test.ts",
      'import { readFileSync } from "node:fs"; readFileSync("docs/read.md");',
    );
    expect(
      await planPostgresTests({
        event: "pull_request",
        scopeUnknown: false,
        changed: ["docs/read.md"],
        root,
      }),
    ).toEqual({ mode: "all" });
  });
});

test("unknown paths, empty diffs, malformed metadata, and broken import graphs widen to all", async () => {
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource('import "./entry";'));
    for (const [changed, scopeUnknown] of [
      [["outside/unrecognized.bin"], false],
      [[], false],
      [["apps/api/src/feature/entry.ts"], true],
    ] as const) {
      expect(
        await planPostgresTests({
          event: "merge_group",
          scopeUnknown,
          changed,
          root,
        }),
      ).toEqual({ mode: "all" });
    }

    write("apps/api/package.json", JSON.stringify({ ciGateTestRunners: {} }));
    expect(
      await planPostgresTests({
        event: "merge_group",
        scopeUnknown: false,
        changed: ["apps/api/src/feature/db.test.ts"],
        root,
      }),
    ).toEqual({ mode: "all" });

    write(
      "apps/api/package.json",
      JSON.stringify({
        name: "@stll/api",
        ciGateTestRunners: {
          "test:postgres": {
            gate: POSTGRES_GATE,
            testFileGlob: "src/**/*.test.ts",
          },
        },
      }),
    );
    write("apps/api/src/feature/entry.ts", "export const value = true;");
    expect(
      await planPostgresTests({
        event: "merge_group",
        scopeUnknown: false,
        changed: ["apps/api/src/feature/entry.ts"],
        root,
      }),
    ).toEqual({ mode: "selected", files: ["src/feature/db.test.ts"] });
    write(
      "apps/api/src/unrelated-broken.test.ts",
      gateSource('import "./deleted-module";'),
    );
    expect(
      await planPostgresTests({
        event: "merge_group",
        scopeUnknown: false,
        changed: ["apps/api/src/feature/entry.ts"],
        root,
      }),
    ).toEqual({ mode: "all" });
  });
});

test("merge groups and pull requests plan selection regardless of execution switch", async () => {
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource('import "./entry";'));
    write("apps/api/src/feature/entry.ts", 'export { value } from "./leaf";');
    write("apps/api/src/feature/leaf.ts", "export const value = true;");
    write("apps/api/src/other.test.ts", gateSource(""));
    write("apps/api/src/unrelated.ts", "export const untouched = true;");

    const input = {
      scopeUnknown: false,
      root,
    } as const;
    expect(
      await planPostgresTests({
        ...input,
        event: "merge_group",
        changed: ["apps/api/src/feature/leaf.ts"],
      }),
    ).toEqual({ mode: "selected", files: ["src/feature/db.test.ts"] });
    expect(
      await planPostgresTests({
        ...input,
        event: "merge_group",
        changed: ["apps/api/src/feature/db.test.ts"],
      }),
    ).toEqual({ mode: "selected", files: ["src/feature/db.test.ts"] });
    expect(
      await planPostgresTests({
        ...input,
        event: "merge_group",
        changed: ["apps/api/src/unrelated.ts"],
      }),
    ).toEqual({ mode: "none" });
    expect(
      await planPostgresTests({
        ...input,
        event: "pull_request",
        changed: ["apps/api/src/feature/leaf.ts"],
      }),
    ).toEqual({ mode: "selected", files: ["src/feature/db.test.ts"] });
    expect(
      await planPostgresTests({
        ...input,
        event: "workflow_dispatch",
        changed: ["apps/api/src/feature/leaf.ts"],
      }),
    ).toEqual({ mode: "all" });
  });
});

test("Postgres discovery rejects missing and stale entries with named diagnostics", () => {
  expect(() =>
    assertPostgresDiscovery({
      discovered: ["src/wrong.test.ts"],
      gated: ["src/expected.test.ts"],
      selectorFiles: ["src/expected.test.ts"],
    }),
  ).toThrow(
    "Postgres discovery mismatch: missing=src/expected.test.ts; stale=src/wrong.test.ts; gated=1",
  );
  expect(() =>
    assertPostgresDiscovery({
      discovered: ["src/expected.test.ts"],
      gated: ["src/expected.test.ts"],
      selectorFiles: [],
    }),
  ).toThrow(
    "Postgres discovery mismatch: missing=src/expected.test.ts; stale=; gated=1",
  );
});

test("API eval Postgres suites stay discoverable and mismatches widen", async () => {
  await withRepository(async (root, write) => {
    write("apps/api/src/feature/db.test.ts", gateSource('import "./entry";'));
    write("apps/api/src/feature/entry.ts", "export const value = true;");
    const input = {
      event: "merge_group",
      scopeUnknown: false,
      changed: ["apps/api/src/feature/entry.ts"],
      root,
    };
    expect(await planPostgresTests(input)).toEqual({
      mode: "selected",
      files: ["src/feature/db.test.ts"],
    });
    write("apps/api/evals/new.db.test.ts", gateSource(""));
    expect(listApiTestPaths(path.join(root, "apps/api"))).toContain(
      "evals/new.db.test.ts",
    );
    const discovered = await discoverGatedTestFiles({
      apiRoot: path.join(root, "apps/api"),
      gate: POSTGRES_GATE,
      testFileGlob: API_TEST_FILE_GLOB,
    });
    expect(discovered).toContain("evals/new.db.test.ts");
    expect(await planPostgresTests(input)).toEqual({
      mode: "selected",
      files: ["src/feature/db.test.ts"],
    });

    write(
      "apps/api/package.json",
      JSON.stringify({
        ciGateTestRunners: {
          "test:postgres": {
            gate: POSTGRES_GATE,
            testFileGlob: "src/**/*.test.ts",
          },
        },
      }),
    );
    expect(await planPostgresTests(input)).toEqual({ mode: "all" });
  });
});

test("real gated Postgres files are all selectable and match the source gate census", async () => {
  const runner = packageJson.ciGateTestRunners["test:postgres"];
  const selectorFiles = listApiTestPaths(apiRoot);
  const gated = selectorFiles.filter((file) =>
    readFileSync(path.join(apiRoot, file), "utf-8").includes(runner.gate),
  );
  const discovered = await discoverGatedTestFiles({ apiRoot, ...runner });
  expect(gated.length).toBeGreaterThan(0);
  expect(discovered).toEqual(gated);
  assertPostgresDiscovery({ discovered, gated, selectorFiles });
});

test("malformed or stale selections widen, while none and valid selected plans stay exact", () => {
  const discovered = ["src/db.test.ts", "src/other.test.ts"];
  expect(parseGatedTestSelection('{"mode":"none"}', [])).toEqual({
    mode: "all",
  });
  for (const output of ["{", JSON.stringify({ mode: "selected", files: [] })]) {
    expect(parseGatedTestSelection(output, discovered)).toEqual({
      mode: "all",
    });
  }
  expect(
    parseGatedTestSelection(
      JSON.stringify({ mode: "selected", files: ["src/missing.test.ts"] }),
      discovered,
    ),
  ).toEqual({ mode: "all" });
  expect(
    parseGatedTestSelection(JSON.stringify({ mode: "none" }), discovered),
  ).toEqual({
    mode: "none",
  });
  expect(
    parseGatedTestSelection(
      JSON.stringify({ mode: "selected", files: ["src/db.test.ts"] }),
      discovered,
    ),
  ).toEqual({ mode: "selected", files: ["src/db.test.ts"] });
});

// Measured p95 is 14.7 s; this test must discover and graph the real Postgres suites.
test("verification suites participate in general Postgres discovery and changed-file selection", async () => {
  const runner = packageJson.ciGateTestRunners["test:postgres"];
  const discovered = await discoverGatedTestFiles({ apiRoot, ...runner });
  const verificationFiles = listApiTestPaths(apiRoot).filter((file) =>
    /^(?:src\/(?:lib\/lists\/verification\/|handlers\/lists\/verifications\/).*\.db\.test\.ts|src\/lib\/views\/avt-layout\.db\.test\.ts|src\/db\/list-verification-rls\.db\.test\.ts|src\/lib\/api-handlers-list-verification\.test\.ts)$/u.test(
      file,
    ),
  );
  expect(verificationFiles.length).toBeGreaterThan(0);
  for (const file of verificationFiles) {
    expect(discovered, file).toContain(file);
  }
  const widened = verificationFiles.filter((file) =>
    Object.values(API_ALL_RULES).some((rule) => rule.test(`apps/api/${file}`)),
  );
  for (const file of widened) {
    const selection = await planPostgresTests({
      event: "pull_request",
      scopeUnknown: false,
      changed: [`apps/api/${file}`],
    });
    expect(selection.mode, file).toBe("all");
  }
  // One graph plan for the rest: each plan rebuilds the API import graph, and
  // per-file plans pushed this test past its budget on CI.
  const graphed = verificationFiles.filter((file) => !widened.includes(file));
  expect(graphed.length).toBeGreaterThan(0);
  const selection = await planPostgresTests({
    event: "pull_request",
    scopeUnknown: false,
    changed: graphed.map((file) => `apps/api/${file}`),
  });
  expect(selection.mode).toBe("selected");
  if (selection.mode === "selected") {
    for (const file of graphed) {
      expect(selection.files, file).toContain(file);
    }
  }
  const sourceReview = await planPostgresTests({
    event: "pull_request",
    scopeUnknown: false,
    changed: [
      "apps/api/src/handlers/lists/items/sources/verification/update.ts",
    ],
  });
  expect(sourceReview.mode).not.toBe("none");
  if (sourceReview.mode === "selected") {
    expect(sourceReview.files).toContain(
      "src/lib/api-handlers-list-verification.test.ts",
    );
  }
}, 30_000);

// Measured p95 is 25.0 s; this test must rebuild the real API graph for each declaration.
test("a change to any online lock-taking declaration selects the contention suite", async () => {
  const suite = "src/db/online-ddl-contention.postgres.test.ts";
  const runner = packageJson.ciGateTestRunners["test:postgres"];
  expect(await discoverGatedTestFiles({ apiRoot, ...runner })).toContain(suite);
  // The registries, the owner and every repair live in the database modules,
  // whose rule widens to the whole suite.
  for (const file of [
    "apps/api/src/db/online-migrations.ts",
    "apps/api/src/db/online-ddl.ts",
    "apps/api/src/db/sanctions-monitoring-constraint-validation.ts",
  ]) {
    expect(API_ALL_RULES.database.test(file), file).toBe(true);
  }
  // Declarations outside them reach the suite through its import graph, each
  // on its own.
  const declarations = [
    "apps/api/src/lib/case-law/coverage-index.ts",
    "apps/api/src/lib/case-law/published-decisions-sql.ts",
    "apps/api/src/lib/legal-search/sk-document-outstanding-index.ts",
    "apps/api/src/lib/db/migration-history.ts",
  ];
  for (const file of declarations) {
    expect(
      Object.values(API_ALL_RULES).some((rule) => rule.test(file)),
      file,
    ).toBe(false);
  }
  for (const file of declarations) {
    const selection = await planPostgresTests({
      event: "pull_request",
      scopeUnknown: false,
      changed: [file],
    });
    expect(selection.mode, file).toBe("selected");
    if (selection.mode === "selected") {
      expect(selection.files, file).toContain(suite);
    }
  }
}, 50_000);
