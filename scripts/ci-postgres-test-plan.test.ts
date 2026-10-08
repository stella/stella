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
import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import { parseGatedTestSelection } from "../apps/api/scripts/gated-test-selection";
import { discoverGatedTestFiles } from "../apps/api/scripts/run-gated-tests";
import { API_ALL_RULES } from "./api-test-impact";
import {
  assertPostgresDiscovery,
  planPostgresTests,
} from "./ci-postgres-test-plan";

const POSTGRES_GATE = "STELLA_RUN_POSTGRES_TESTS";
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
            testFileGlob: "src/**/*.test.ts",
          },
        },
      }),
    );
    write("apps/api/src/tests/setup-env.ts", 'import "./preload-helper";');
    write("apps/api/src/tests/preload-helper.ts", "export const setup = true;");
    write("apps/api/scripts/test-durations.json", JSON.stringify({}));
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
  github: ".github/actions/test/action.yml",
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

test("a new gated test outside the runner glob cannot turn into none affected", async () => {
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
      testFileGlob: "src/**/*.test.ts",
    });
    expect(discovered).not.toContain("evals/new.db.test.ts");
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
