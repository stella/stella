import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "tsrs/unstable/async";

import {
  analyzeTestSubjectReachability,
  checkReachabilityBaselineMembership,
  REACHABILITY_CATEGORIES,
  type ReachabilityCategory,
  type ReachabilityFinding,
} from "./test-subject-reachability";

const TEST_FILE = "apps/example/src/widget.test.tsx";
const IMPORT_ATTEMPTED = [
  "imported-source-subject",
] satisfies readonly ReachabilityCategory[];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = (testSource: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "subject-reachability-"));
  roots.push(root);
  mkdirSync(path.join(root, "apps/example/src"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/example/src/widget.ts"),
    "export const reduceWidgetState = () => 'real';\nexport const createHandler = () => reduceWidgetState;\nexport const WidgetPanel = () => null;\n",
  );
  writeFileSync(
    path.join(root, "apps/example/src/widget.test.tsx"),
    testSource,
  );
  return { root, files: [TEST_FILE] as const };
};

const git = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};

describe("test subject reachability", () => {
  test("excludes lint specimens from explicit and tracked executable test inputs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "subject-reachability-"));
    roots.push(root);
    const lintFixture = ".oxlint-plugins/__fixtures__/timer.fixture.test.ts";
    const realTest = ".oxlint-plugins/__tests__/timer.test.ts";
    mkdirSync(path.join(root, ".oxlint-plugins/__fixtures__"), {
      recursive: true,
    });
    mkdirSync(path.join(root, ".oxlint-plugins/__tests__"), {
      recursive: true,
    });
    writeFileSync(path.join(root, lintFixture), "setTimeout(() => {}, 1);\n");
    writeFileSync(
      path.join(root, realTest),
      "test('unclassified', () => {});\n",
    );
    git(root, "init", "-q");
    git(root, "add", ".");
    const expected = [
      {
        file: realTest,
        kind: "no-classified-reachability" as const,
        attempted: REACHABILITY_CATEGORIES,
      },
    ];
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: root,
        files: [realTest, lintFixture],
      }),
    ).toEqual(expected);
    expect(await analyzeTestSubjectReachability({ repoRoot: root })).toEqual(
      expected,
    );
  });

  test("the compiler source index and independent sibling parses give identical findings", async () => {
    const input = fixture("");
    const sibling = path.join(input.root, "apps/example/src/widget.ts");
    const compiler = new API({ cwd: input.root });
    try {
      const independentSibling = async (filename: string) =>
        (
          await compiler.createSourceFile(
            filename,
            readFileSync(filename, "utf-8"),
          )
        ).sourceFile;
      const sources = [
        "import { reduceWidgetState } from './widget'; test('state', () => reduceWidgetState());",
        "import { createHandler } from './widget.js'; const reduceWidgetState = () => 'stand-in'; test('state', () => createHandler());",
        "const reduceWidgetState = () => 'stand-in'; test('state', () => reduceWidgetState());",
      ];
      for (const source of sources) {
        writeFileSync(path.join(input.root, TEST_FILE), source);
        const options = { repoRoot: input.root, files: input.files };
        const indexed = await analyzeTestSubjectReachability(options);
        expect(indexed).toEqual(
          await analyzeTestSubjectReachability({
            ...options,
            siblingSource: independentSibling,
          }),
        );
        if (source.includes("stand-in")) {
          expect(indexed).toContainEqual({
            file: TEST_FILE,
            kind: "local-export-collision",
            name: "reduceWidgetState",
          });
        } else {
          expect(indexed).toEqual([]);
        }
      }
      // An edited export must invalidate the next scan even when the test text is identical.
      writeFileSync(sibling, "export const replacement = () => 'real';");
      const options = { repoRoot: input.root, files: input.files };
      const findings = await analyzeTestSubjectReachability(options);
      expect(findings).toEqual(
        await analyzeTestSubjectReachability({
          ...options,
          siblingSource: independentSibling,
        }),
      );
      expect(
        findings.some(({ kind }) => kind === "local-export-collision"),
      ).toBe(false);
      expect(
        findings.some(({ kind }) => kind === "no-classified-reachability"),
      ).toBe(true);
    } finally {
      await compiler.close();
    }
  });

  test("reports a stand-in state machine and component", async () => {
    const input = fixture(
      "const reduceWidgetState = () => 'stand-in';\nconst WidgetPanel = () => null;\ntest('state', () => reduceWidgetState());\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([
      {
        file: TEST_FILE,
        kind: "local-export-collision",
        name: "WidgetPanel",
      },
      {
        file: TEST_FILE,
        kind: "local-export-collision",
        name: "reduceWidgetState",
      },
      {
        file: TEST_FILE,
        kind: "no-classified-reachability",
        attempted: REACHABILITY_CATEGORIES,
      },
    ]);
  });

  test("a test that drives a patched dependency reaches the committed patch", async () => {
    const drives =
      "import { PostMessageTransport } from '@vendor/client';\ntest('limits', () => new PostMessageTransport());\n";
    const unclassified: ReachabilityFinding[] = [
      {
        file: TEST_FILE,
        kind: "no-classified-reachability",
        attempted: REACHABILITY_CATEGORIES,
      },
    ];
    const analyze = async (source: string, patchedDependencies?: object) => {
      const input = fixture(source);
      if (patchedDependencies) {
        writeFileSync(
          path.join(input.root, "package.json"),
          JSON.stringify({ patchedDependencies }),
        );
      }
      return await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      });
    };
    const patched = {
      "@vendor/client@7.1.1": "patches/@vendor%2Fclient@7.1.1.patch",
    };

    expect(await analyze(drives, patched)).toEqual([]);
    const drivesDynamically =
      "const { PostMessageTransport } = await import('@vendor/client');\ntest('limits', () => new PostMessageTransport());\n";
    expect(await analyze(drivesDynamically, patched)).toEqual([]);
    expect(await analyze(drivesDynamically)).toEqual(unclassified);
    expect(
      await analyze(
        drives.replace("@vendor/client", "@vendor/client/transport"),
        patched,
      ),
    ).toEqual([]);
    expect(await analyze(drives)).toEqual(unclassified);
    expect(
      await analyze(drives, { "@vendor/other@1.0.0": "patches/other.patch" }),
    ).toEqual(unclassified);
    expect(
      await analyze(
        "import { PostMessageTransport } from '@vendor/client';\ntest('limits', () => expect(true).toBe(true));\n",
        patched,
      ),
    ).toEqual(unclassified);
  });

  test("follows an alias wrapper to the real subject", async () => {
    const input = fixture(
      "import { reduceWidgetState as realReducer } from './widget';\nconst reduce = () => realReducer();\ntest('state', reduce);\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);

    writeFileSync(
      path.join(input.root, input.files[0]),
      "import { reduceWidgetState as realReducer } from './widget';\nconst reduce = () => 'stand-in';\ntest('state', reduce);\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([
      {
        file: TEST_FILE,
        kind: "no-classified-reachability",
        attempted: IMPORT_ATTEMPTED,
      },
    ]);
  });

  test("resolves a NodeNext .js import to its TypeScript source", async () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget.js';\ntest('state', () => expect(reduceWidgetState()).toBe('real'));\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("follows a module-scope result initializer to the real subject", async () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\nconst actual = reduceWidgetState();\ntest('state', () => expect(actual).toBe('real'));\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("follows a module-scope factory initializer to the real subject", async () => {
    const input = fixture(
      "import { createHandler } from './widget';\nconst handler = createHandler();\ntest('state', () => expect(handler()).toBe('real'));\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("classifies a directly tested support factory as the real subject", async () => {
    const { root } = fixture("");
    const helperFile = "apps/example/src/tests/helpers/test-mutants.ts";
    const testFile = "apps/example/src/tests/helpers/test-mutants.test.ts";
    mkdirSync(path.dirname(path.join(root, helperFile)), { recursive: true });
    writeFileSync(
      path.join(root, helperFile),
      "export const createTestMutantDirectory = (prefix: string) => prefix;\n",
    );
    writeFileSync(
      path.join(root, testFile),
      "import { createTestMutantDirectory } from './test-mutants';\ntest('directory', () => expect(createTestMutantDirectory('mutant-')).toBe('mutant-'));\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: root,
        files: [testFile],
      }),
    ).toEqual([]);

    writeFileSync(
      path.join(root, testFile),
      "import { createTestMutantDirectory } from './test-mutants';\nconst unused = () => createTestMutantDirectory('mutant-');\ntest('directory', () => expect('stand-in').toBe('stand-in'));\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: root,
        files: [testFile],
      }),
    ).toEqual([
      {
        file: testFile,
        kind: "no-classified-reachability",
        attempted: ["source-factory"],
      },
    ]);
  });

  test("does not count an imported subject hidden in an uncalled wrapper", async () => {
    const input = fixture(
      "import { reduceWidgetState as realReducer } from './widget';\nconst unused = () => realReducer();\nconst reduceWidgetState = () => 'stand-in';\ntest('state', () => reduceWidgetState());\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([
      {
        file: TEST_FILE,
        kind: "local-export-collision",
        name: "reduceWidgetState",
      },
      {
        file: TEST_FILE,
        kind: "no-classified-reachability",
        attempted: IMPORT_ATTEMPTED,
      },
    ]);
  });

  test("does not count a type-only reference to an imported subject", async () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\ntype Subject = typeof reduceWidgetState;\nconst standIn: Subject = () => 'stand-in';\ntest('state', () => standIn());\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([
      {
        file: TEST_FILE,
        kind: "no-classified-reachability",
        attempted: IMPORT_ATTEMPTED,
      },
    ]);
  });

  test("does not count a shadowed local binding as the imported subject", async () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\ntest('state', () => { const reduceWidgetState = () => 'stand-in'; return reduceWidgetState(); });\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([
      {
        file: TEST_FILE,
        kind: "no-classified-reachability",
        attempted: IMPORT_ATTEMPTED,
      },
    ]);
  });

  test("classifies a spawned source entry", async () => {
    const input = fixture(
      "test('cli', () => Bun.spawn(['bun', 'apps/example/src/widget.ts']));\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("classifies a bundled source entry", async () => {
    const input = fixture(
      "test('bundle', () => Bun.build({ entrypoints: ['apps/example/src/widget.ts'] }));\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("classifies raw SQL against a migrated test database", async () => {
    const input = fixture(
      "test('gate', async () => { const client = await createTestPglite(); await client.query('SELECT 1'); });\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  const UNREACHED_HELPER_CASES = [
    {
      title: "an imported subject in an uncalled helper inside the test body",
      source:
        "import { reduceWidgetState as realReducer } from './widget';\ntest('state', () => { const unused = () => realReducer(); function alsoUnused() { return realReducer(); } expect(standIn()).toBe('fake'); });\n",
      attempted: IMPORT_ATTEMPTED,
    },
    {
      title: "a spawn in an uncalled module helper",
      source:
        "const unused = () => Bun.spawn(['bun', 'apps/example/src/widget.ts']);\ntest('state', () => expect(standIn()).toBe('fake'));\n",
      attempted: REACHABILITY_CATEGORIES,
    },
    {
      title: "a build in an uncalled helper inside the test body",
      source:
        "test('state', () => { const unused = () => Bun.build({ entrypoints: ['apps/example/src/widget.ts'] }); expect(standIn()).toBe('fake'); });\n",
      attempted: REACHABILITY_CATEGORIES,
    },
    {
      title: "a file read in an uncalled module helper",
      source:
        "function unused() { return readFileSync('apps/example/src/widget.ts', 'utf-8'); }\ntest('state', () => expect(standIn()).toBe('fake'));\n",
      attempted: REACHABILITY_CATEGORIES,
    },
  ] as const;

  for (const { title, source, attempted } of UNREACHED_HELPER_CASES) {
    test(`does not count ${title}`, async () => {
      const input = fixture(source);
      expect(
        await analyzeTestSubjectReachability({
          repoRoot: input.root,
          files: input.files,
        }),
      ).toEqual([
        { file: TEST_FILE, kind: "no-classified-reachability", attempted },
      ]);
    });
  }

  const REACHED_HELPER_CASES = [
    {
      title: "a called helper declared inside the test body",
      source:
        "import { reduceWidgetState } from './widget';\ntest('state', () => { const run = () => reduceWidgetState(); expect(run()).toBe('real'); });\n",
    },
    {
      title: "an inline callback passed to an assertion",
      source:
        "import { reduceWidgetState } from './widget';\ntest('state', () => { expect(() => reduceWidgetState()).not.toThrow(); });\n",
    },
    {
      title: "a helper handed out by a fixture factory",
      source:
        "import { reduceWidgetState } from './widget';\nconst setup = () => { const run = () => reduceWidgetState(); return { run }; };\ntest('state', () => { const f = setup(); expect(f.run()).toBe('real'); });\n",
    },
    {
      title: "a helper called inside an inline callback",
      source:
        "const readSchema = () => readFileSync('drizzle/0001/migration.sql', 'utf-8');\ntest('schema', async () => { await withDb(async () => { readSchema(); }); });\n",
    },
    {
      title: "a spawn in a called module helper",
      source:
        "const runCli = () => Bun.spawn(['bun', 'apps/example/src/widget.ts']);\ntest('cli', () => runCli());\n",
    },
  ] as const;

  for (const { title, source } of REACHED_HELPER_CASES) {
    test(`counts ${title}`, async () => {
      const input = fixture(source);
      expect(
        await analyzeTestSubjectReachability({
          repoRoot: input.root,
          files: input.files,
        }),
      ).toEqual([]);
    });
  }

  const SOURCE_INDEX_CASES = [
    {
      label: "relative path",
      specifier: "../../../packages/scripts/src/source-file-index",
      manifest: { name: "@stll/scripts" },
      reached: true,
    },
    {
      label: "package subpath without an exports map",
      specifier: "@stll/scripts/src/source-file-index",
      manifest: { name: "@stll/scripts" },
      reached: true,
    },
    {
      label: "exported subpath",
      specifier: "@stll/scripts/source-file-index",
      manifest: {
        name: "@stll/scripts",
        exports: { "./source-file-index": "./src/source-file-index.ts" },
      },
      reached: true,
    },
    {
      label: "wildcard export",
      specifier: "@stll/scripts/source-file-index",
      manifest: { name: "@stll/scripts", exports: { "./*": "./src/*.ts" } },
      reached: true,
    },
    {
      label: "subpath the exports map does not expose",
      specifier: "@stll/scripts/src/source-file-index",
      manifest: { name: "@stll/scripts", exports: { ".": "./src/index.ts" } },
      reached: false,
    },
  ] as const;

  test.each(SOURCE_INDEX_CASES)(
    "classifies a shared source index read through a $label",
    async ({ specifier, manifest, reached }) => {
      const input = fixture(
        `import { sourceFileIndex } from '${specifier}';\ntest('inventory', () => sourceFileIndex().includes('widget.ts'));\n`,
      );
      mkdirSync(path.join(input.root, "packages/scripts/src"), {
        recursive: true,
      });
      writeFileSync(
        path.join(input.root, "packages/scripts/package.json"),
        JSON.stringify(manifest),
      );
      writeFileSync(
        path.join(input.root, "packages/scripts/src/source-file-index.ts"),
        "export const sourceFileIndex = () => ['widget.ts'];\n",
      );

      expect(
        await analyzeTestSubjectReachability({
          repoRoot: input.root,
          files: input.files,
        }),
      ).toEqual(
        reached
          ? []
          : [
              {
                file: TEST_FILE,
                kind: "no-classified-reachability",
                attempted: REACHABILITY_CATEGORIES,
              },
            ],
      );
    },
  );

  test("follows a subject passed through a registered test harness", async () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\nconst registerCases = (options: { run: () => string }) => test('case', options.run);\nregisterCases({ run: () => reduceWidgetState() });\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("follows a subject passed through an awaited registered test harness", async () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\nconst registerCases = async (options: { run: () => string }) => { await Promise.resolve(); test('case', options.run); };\nawait registerCases({ run: () => reduceWidgetState() });\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("follows a dynamically imported component through a UI harness", async () => {
    const input = fixture(
      "const { WidgetPanel } = await import('./widget');\nconst mount = () => WidgetPanel();\ntest('ui', mount);\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("follows a module-scope destructured owner factory", async () => {
    const input = fixture(
      "import { createHandler } from './widget';\nconst { call } = { call: createHandler() };\ntest('owner', () => call());\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("accepts dependency injection and a model beside the real component", async () => {
    const input = fixture(
      "import { WidgetPanel, reduceWidgetState } from './widget';\nconst model = () => 'oracle';\nconst makeHarness = (subject: typeof reduceWidgetState) => subject();\ntest('ui', () => { WidgetPanel(); return makeHarness(reduceWidgetState) === model(); });\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("does not treat a fixture builder name as a subject stand-in", async () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\nconst widgetFixture = () => ({ state: 'ready' });\ntest('fixture', () => reduceWidgetState(widgetFixture()));\n",
    );
    writeFileSync(
      path.join(input.root, "apps/example/src/widget.ts"),
      "export const widgetFixture = () => ({ state: 'production' });\nexport const reduceWidgetState = (value: unknown) => value;\n",
    );
    expect(
      await analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("rejects an exception added to the head baseline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "subject-reachability-git-"));
    roots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts/test-subject-reachability-baseline.json"),
      "{}\n",
    );
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD");
    writeFileSync(
      path.join(root, "scripts/test-subject-reachability-baseline.json"),
      `${JSON.stringify({ [TEST_FILE]: ["no-classified-reachability"] })}\n`,
    );

    expect(checkReachabilityBaselineMembership(root, ["--base", base])).toBe(1);
  });
});
