import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readCiCheckCommandText } from "./ci-check-pool-registry";
import { comparisonBase } from "./ci-comparison-base";
import {
  balanceTestFiles,
  parseScriptTestArguments,
  prepareStrace,
  SCAN_PRELOAD_PATH,
  selectScriptTests,
  tracedAllowance,
  uncoveredScans,
  undeclaredTracedFiles,
  unlistedTestCommands,
  unlistedTests,
} from "./run-unlisted-script-tests";
import scriptTestInputs from "./script-test-inputs.json" with { type: "json" };

describe("balanceTestFiles", () => {
  const weights: Record<string, number> = {
    "scripts/a.test.ts": 9,
    "scripts/b.test.ts": 5,
    "scripts/c.test.ts": 4,
    "scripts/d.test.ts": 3,
    "scripts/e.test.ts": 3,
  };
  const weightOf = (file: string) => weights[file] ?? 0;

  test("places every file exactly once, heaviest first onto the lightest group", () => {
    const groups = balanceTestFiles(Object.keys(weights), 2, weightOf);
    expect(groups).toEqual([
      ["scripts/a.test.ts", "scripts/d.test.ts"],
      ["scripts/b.test.ts", "scripts/c.test.ts", "scripts/e.test.ts"],
    ]);
    expect(groups.flat().toSorted()).toEqual(Object.keys(weights).toSorted());
  });

  test("is independent of input order", () => {
    const files = Object.keys(weights);
    expect(balanceTestFiles(files.toReversed(), 2, weightOf)).toEqual(
      balanceTestFiles(files, 2, weightOf),
    );
  });

  test("never makes empty groups", () => {
    expect(balanceTestFiles(["scripts/a.test.ts"], 3, weightOf)).toEqual([
      ["scripts/a.test.ts"],
    ]);
    expect(balanceTestFiles([], 2, weightOf)).toEqual([]);
  });

  test("splits Bun tests into one command per group with the timeout on each", () => {
    expect(
      unlistedTestCommands({
        files: ["scripts/a.test.ts", "scripts/b.test.ts", "scripts/check.sh"],
        timeout: 35_000,
        groups: 2,
        weightOf,
      }),
    ).toEqual([
      ["bun", "test", "--timeout", "35000", "scripts/a.test.ts"],
      ["bun", "test", "--timeout", "35000", "scripts/b.test.ts"],
      ["bash", "scripts/check.sh"],
    ]);
  });
});

describe("unlistedTests", () => {
  test("nested parallel commands remain listed without losing the remainder", () => {
    expect(
      unlistedTests(
        ["scripts/nested.test.ts", "scripts/unlisted.test.ts"],
        "jobs:\n  checks:\n    steps:\n      - parallel:\n          - parallel:\n              - name: Nested check\n                run: bun test scripts/nested.test.ts\n",
      ),
    ).toEqual(["scripts/unlisted.test.ts"]);
  });

  test("keeps only the tests no workflow names", () => {
    const workflowText = [
      "run: bun test scripts/listed.test.ts",
      "run: bash scripts/listed-shell.test.sh",
    ].join("\n");

    expect(
      unlistedTests(
        [
          "scripts/orphan.test.ts",
          "scripts/listed.test.ts",
          "scripts/listed-shell.test.sh",
          "scripts/orphan-shell.test.sh",
        ],
        workflowText,
      ),
    ).toEqual(["scripts/orphan-shell.test.sh", "scripts/orphan.test.ts"]);
  });

  test("does not count a test as listed because a longer name contains it", () => {
    expect(
      unlistedTests(
        ["scripts/plan.test.ts"],
        "run: bun test scripts/ci-plan.test.ts",
      ),
    ).toEqual(["scripts/plan.test.ts"]);
  });

  test("does not count a test named only in a comment as listed", () => {
    expect(
      unlistedTests(
        ["scripts/commented.test.ts"],
        "      # see scripts/commented.test.ts\n      run: bun test other",
      ),
    ).toEqual(["scripts/commented.test.ts"]);
  });
});

describe("parseScriptTestArguments", () => {
  test("accepts the default and a positive integer timeout", () => {
    expect(parseScriptTestArguments([])).toEqual({
      type: "valid",
      timeout: undefined,
    });
    expect(parseScriptTestArguments(["--timeout", "35000"])).toEqual({
      type: "valid",
      timeout: 35_000,
    });
  });

  test.each([
    [["--unknown"], "unknown argument"],
    [["--timeout"], "requires a positive integer"],
    [["--timeout", "0"], "requires a positive integer"],
    [["--timeout", "-1"], "requires a positive integer"],
    [["--timeout", "1.5"], "requires a positive integer"],
    [["--timeout", "9007199254740992"], "requires a positive integer"],
    [["--timeout", "1", "--timeout", "2"], "may be supplied once"],
  ] as const)("rejects %j", (args, message) => {
    expect(parseScriptTestArguments(args)).toEqual({
      type: "invalid",
      message: expect.stringContaining(message),
    });
  });
});

describe("unlistedTestCommands", () => {
  test("forwards the timeout to all Bun tests and preserves shell invocations", () => {
    expect(
      unlistedTestCommands({
        files: [
          "scripts/first.test.ts",
          "scripts/second.test.ts",
          "scripts/check.sh",
        ],
        timeout: 35_000,
      }),
    ).toEqual([
      [
        "bun",
        "test",
        "--timeout",
        "35000",
        "scripts/first.test.ts",
        "scripts/second.test.ts",
      ],
      ["bash", "scripts/check.sh"],
    ]);
  });

  test("preserves the default Bun invocation when timeout is absent", () => {
    expect(
      unlistedTestCommands({
        files: ["scripts/first.test.ts", "scripts/check.sh"],
        timeout: undefined,
      }),
    ).toEqual([
      ["bun", "test", "scripts/first.test.ts"],
      ["bash", "scripts/check.sh"],
    ]);
  });
});

describe("script test impact selection", () => {
  const makeFixture = () => {
    const root = mkdtempSync(path.join(tmpdir(), "script-test-impact-"));
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts/run-unlisted-script-tests.ts"),
      "export const runner = true;\n",
    );
    writeFileSync(
      path.join(root, "scripts/subject.ts"),
      'import { value } from "./transitive"; export { value };\n',
    );
    writeFileSync(
      path.join(root, "scripts/transitive.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(
      path.join(root, "scripts/subject.test.ts"),
      'import { value } from "./subject"; void value;\n',
    );
    writeFileSync(
      path.join(root, "scripts/reader.test.ts"),
      'import { readFileSync } from "node:fs"; readFileSync("data/value.txt");\n',
    );
    return root;
  };

  test("selects changed subjects, transitive imports, declared data, and new tests", () => {
    const root = makeFixture();
    const tests = ["scripts/subject.test.ts", "scripts/reader.test.ts"];
    const inputs = { "scripts/reader.test.ts": ["data/**"] };
    try {
      expect(
        selectScriptTests({
          tests,
          changed: ["scripts/subject.ts"],
          root,
          inputs,
        }).files,
      ).toEqual(["scripts/subject.test.ts"]);
      expect(
        selectScriptTests({
          tests,
          changed: ["scripts/transitive.ts"],
          root,
          inputs,
        }).files,
      ).toEqual(["scripts/subject.test.ts"]);
      expect(
        selectScriptTests({ tests, changed: ["data/value.txt"], root, inputs })
          .files,
      ).toEqual(["scripts/reader.test.ts"]);
      expect(
        selectScriptTests({
          tests,
          changed: ["scripts/reader.test.ts"],
          root,
          inputs,
        }).files,
      ).toEqual(["scripts/reader.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configuration and runner changes select every test", () => {
    const root = makeFixture();
    const tests = ["scripts/subject.test.ts", "scripts/reader.test.ts"];
    const inputs = { "scripts/reader.test.ts": ["data/**"] };
    try {
      for (const changed of [
        "package.json",
        "bun.lock",
        "tsconfig.build.json",
        "bunfig.toml",
        "scripts/run-unlisted-script-tests.ts",
      ]) {
        expect(
          selectScriptTests({ tests, changed: [changed], root, inputs }).files,
        ).toEqual(tests);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails the census for a reader without declared data inputs", () => {
    const root = makeFixture();
    try {
      expect(() =>
        selectScriptTests({
          tests: ["scripts/reader.test.ts"],
          changed: [],
          root,
          inputs: {},
        }),
      ).toThrow("undeclared data inputs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails the census for an empty reader declaration", () => {
    const root = makeFixture();
    try {
      expect(() =>
        selectScriptTests({
          tests: ["scripts/reader.test.ts"],
          changed: [],
          root,
          inputs: { "scripts/reader.test.ts": [] },
        }),
      ).toThrow("undeclared data inputs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("tracing names tracked reads outside the closure and declarations", () => {
  expect(
    undeclaredTracedFiles({
      trace: `1 openat(AT_FDCWD, "${path.resolve("apps/api/Dockerfile")}", O_RDONLY) = 3\n1 openat(AT_FDCWD, "${path.resolve("scripts/subject.test.ts")}", O_RDONLY) = 3`,
      closure: new Set(["scripts/subject.test.ts"]),
      declared: [],
      tracked: new Set(["apps/api/Dockerfile", "scripts/subject.test.ts"]),
    }),
  ).toEqual(["apps/api/Dockerfile"]);
});

test("the Dockerfile reader's trace is covered by its declaration", () => {
  const dockerfile = "apps/api/Dockerfile";
  expect(
    undeclaredTracedFiles({
      trace: `1 openat(AT_FDCWD, "${path.resolve(dockerfile)}", O_RDONLY) = 3`,
      closure: new Set(["scripts/api-dockerfile-entrypoints.test.ts"]),
      declared:
        scriptTestInputs.inputs["scripts/api-dockerfile-entrypoints.test.ts"],
      tracked: new Set([dockerfile]),
    }),
  ).toEqual([]);
});

test("the YARA directory scan is covered by its repository declaration", () => {
  const testFile = "scripts/workflow-api-probes.test.ts";
  expect(
    uncoveredScans({
      scanLog: `${JSON.stringify({
        directory: path.resolve("apps/api/src/lib/file-scan/yara"),
        pattern: "*.yar",
      })}\n`,
      declared: scriptTestInputs.inputs[testFile],
      tracked: new Set([
        "apps/api/src/lib/file-scan/yara/executables.yar",
        "apps/api/src/lib/file-scan/yara/office-macros.yar",
      ]),
    }),
  ).toEqual([]);
});

describe("directory scan coverage", () => {
  const withTrackedFixture = (
    run: (fixture: { root: string; tracked: Set<string> }) => void,
  ) => {
    const root = mkdtempSync(path.join(tmpdir(), "script-scans-"));
    mkdirSync(path.join(root, "data"));
    writeFileSync(path.join(root, "data/a.txt"), "a");
    writeFileSync(path.join(root, "data/b.txt"), "b");
    try {
      run({ root, tracked: new Set(["data/a.txt", "data/b.txt"]) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("a directory scan requires one structural recursive declaration", () => {
    withTrackedFixture(({ root, tracked }) => {
      const scanLog = `${JSON.stringify({ directory: "data" })}\n`;
      for (const declared of [
        "data/*",
        "data/*.txt",
        "data/**/_*",
        "data/**/*.json",
      ]) {
        expect(
          uncoveredScans({ scanLog, declared: [declared], tracked, root }),
        ).toEqual([{ directory: "data" }]);
      }
      for (const declared of ["data/**", "**"]) {
        expect(
          uncoveredScans({ scanLog, declared: [declared], tracked, root }),
        ).toEqual([]);
      }
    });
  });

  test("empty directories use the same structural coverage rule", () => {
    withTrackedFixture(({ root }) => {
      mkdirSync(path.join(root, "empty"));
      const scanLog = `${JSON.stringify({ directory: "empty" })}\n`;
      expect(
        uncoveredScans({
          scanLog,
          declared: ["empty/*.txt"],
          tracked: new Set(),
          root,
        }),
      ).toEqual([{ directory: "empty" }]);
      expect(
        uncoveredScans({
          scanLog,
          declared: ["empty/**"],
          tracked: new Set(),
          root,
        }),
      ).toEqual([]);
    });
  });

  test("an ancestor recursive declaration covers a nested scan", () => {
    withTrackedFixture(({ root, tracked }) => {
      const scanLog = `${JSON.stringify({ directory: "parent/data" })}\n`;
      expect(
        uncoveredScans({ scanLog, declared: ["parent/**"], tracked, root }),
      ).toEqual([]);
    });
  });

  test("recognizes a subprocess git ls-files scan", () => {
    withTrackedFixture(({ root, tracked }) => {
      const trace = [
        `1 openat(AT_FDCWD<${root}>, ".git", O_RDONLY) = 3`,
        '1 execve("/usr/bin/git", ["git", "ls-files", "--", "data"], 0x0) = 0',
      ].join("\n");
      for (const declared of [["data/a.txt"], ["data/*"]]) {
        expect(
          uncoveredScans({ scanLog: "", trace, declared, tracked, root }),
        ).toEqual([{ directory: path.join(root, "data") }]);
      }
      expect(
        uncoveredScans({
          scanLog: "",
          trace,
          declared: ["data/**"],
          tracked,
          root,
        }),
      ).toEqual([]);
    });
  });

  test("the runner's own scan preload is never an undeclared input", () => {
    const closures = new Map<string, ReadonlySet<string>>([
      ["scripts/subject.test.ts", new Set(["scripts/subject.test.ts"])],
      [
        SCAN_PRELOAD_PATH,
        new Set([SCAN_PRELOAD_PATH, "scripts/scan-preload-helper.ts"]),
      ],
    ]);
    const trace = [
      `1 openat(AT_FDCWD</repo>, "${path.resolve(SCAN_PRELOAD_PATH)}", O_RDONLY) = 3`,
      `1 openat(AT_FDCWD</repo>, "${path.resolve("scripts/scan-preload-helper.ts")}", O_RDONLY) = 3`,
    ].join("\n");
    expect(
      undeclaredTracedFiles({
        trace,
        closure: tracedAllowance(
          (file) => closures.get(file) ?? new Set(),
          "scripts/subject.test.ts",
        ),
        declared: [],
        tracked: new Set([SCAN_PRELOAD_PATH, "scripts/scan-preload-helper.ts"]),
      }),
    ).toEqual([]);
  });

  test("a truncated trace record fails instead of escaping verification", () => {
    const trace =
      '1 openat(AT_FDCWD</repo>, "apps/web/src/components/a-very-long-"..., O_RDONLY) = 3';
    expect(() =>
      undeclaredTracedFiles({
        trace,
        closure: new Set(),
        declared: [],
        tracked: new Set(),
      }),
    ).toThrow("Truncated trace record");
  });

  test("resolves subprocess scans against the process working directory", () => {
    withTrackedFixture(({ root, tracked }) => {
      const trace = [
        `1 openat(AT_FDCWD<${root}>, ".", O_RDONLY) = 3`,
        '1 chdir("sub") = 0',
        '1 execve("/usr/bin/ls", ["ls", "data"], 0x0) = 0',
      ].join("\n");
      expect(
        uncoveredScans({
          scanLog: "",
          trace,
          declared: ["sub/**"],
          tracked,
          root,
        }),
      ).toEqual([]);
    });
  });

  test("uses a child's annotation before a parent's resumed clone", () => {
    withTrackedFixture(({ root, tracked }) => {
      const trace = [
        "1 clone(child_stack=NULL <unfinished ...>",
        '2 execve("/usr/bin/ls", ["ls", "data"], 0x0) = 0',
        `2 openat(AT_FDCWD<${root}>, ".", O_RDONLY) = 3`,
        "1 <... clone resumed>) = 2",
      ].join("\n");
      expect(
        uncoveredScans({
          scanLog: "",
          trace,
          declared: ["data/**"],
          tracked,
          root,
        }),
      ).toEqual([]);
    });
  });

  test("fails closed when a traced process has no known working directory", () => {
    withTrackedFixture(({ root, tracked }) => {
      const trace = [
        '1 execve("/bin/sh", ["sh", "-c", "true"], 0x0) = 0',
        '2 execve("/usr/bin/ls", ["ls", "data"], 0x0) = 0',
      ].join("\n");
      expect(() =>
        uncoveredScans({
          scanLog: "",
          trace,
          declared: ["data/*"],
          tracked,
          root,
          testFile: "scripts/example.test.ts",
        }),
      ).toThrow(
        "scripts/example.test.ts: cannot resolve the working directory of a scan by ls",
      );
    });
  });

  test("the preload logs scans and returns the native results unchanged", () => {
    // The preload records real paths (process.cwd() resolves symlinks, such
    // as macOS's /var -> /private/var), so the fixture root is resolved too.
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "scan-preload-")),
    );
    const log = path.join(root, "scans.log");
    mkdirSync(path.join(root, "fixtures/data"), { recursive: true });
    mkdirSync(path.join(root, "fixtures/listed"), { recursive: true });
    writeFileSync(path.join(root, "fixtures/data/a.txt"), "a");
    writeFileSync(path.join(root, "fixtures/listed/b.txt"), "b");
    writeFileSync(
      path.join(root, "subject.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { readdirSync } from "node:fs";',
        'import { opendir } from "node:fs/promises";',
        'test("calls through", async () => {',
        '  process.chdir("fixtures");',
        '  expect(readdirSync("data")).toEqual(["a.txt"]);',
        '  expect([...new Bun.Glob("*.txt").scanSync({ cwd: "data" })]).toEqual(["a.txt"]);',
        "  const names = [];",
        '  for await (const entry of await opendir("listed")) names.push(entry.name);',
        '  expect(names).toEqual(["b.txt"]);',
        "});",
      ].join("\n"),
    );
    try {
      const result = Bun.spawnSync(
        [
          "bun",
          "test",
          "--preload",
          path.resolve(import.meta.dir, "script-test-scan-preload.ts"),
          "subject.test.ts",
        ],
        {
          cwd: root,
          env: { ...process.env, SCRIPT_TEST_SCAN_LOG: log },
          stderr: "pipe",
        },
      );
      expect(result.stderr.toString()).toContain("1 pass");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(log, "utf-8")).toContain(
        `"directory":"${path.join(root, "fixtures/data")}"`,
      );
      expect(readFileSync(log, "utf-8")).toContain('"pattern":"*.txt"');
      // A promise-API listing leaves a scan record too, so a declaration
      // that covers only today's files cannot pass for it.
      expect(readFileSync(log, "utf-8")).toContain(
        `"directory":"${path.join(root, "fixtures/listed")}"`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("the scan preload wraps every node:fs API that lists a directory", async () => {
  const fs = await import("node:fs");
  const { DIRECTORY_SCAN_APIS } = await import("./script-test-scan-preload");
  const listing = /^(?:readdir|opendir|glob)(?:Sync)?$/u;
  expect(
    Object.keys(fs.default)
      .filter(
        (name) =>
          listing.test(name) &&
          typeof Reflect.get(fs.default, name) === "function",
      )
      .toSorted(),
  ).toEqual(
    DIRECTORY_SCAN_APIS.fs
      .filter((name) => typeof Reflect.get(fs.default, name) === "function")
      .toSorted(),
  );
  expect(
    Object.keys(fs.default.promises)
      .filter(
        (name) =>
          listing.test(name) &&
          typeof Reflect.get(fs.default.promises, name) === "function",
      )
      .toSorted(),
  ).toEqual(
    DIRECTORY_SCAN_APIS.promises
      .filter(
        (name) => typeof Reflect.get(fs.default.promises, name) === "function",
      )
      .toSorted(),
  );
});

test("CI does not require or install strace when no tests are selected", () => {
  let installs = 0;
  expect(
    prepareStrace({
      ci: true,
      selectedTests: 0,
      available: () => false,
      install: () => {
        installs += 1;
      },
    }),
  ).toBe(false);
  expect(installs).toBe(0);
});

describe("repository script test census", () => {
  // timeout: the census parses every unlisted test's full repository import closure.
  test("every discoverable test has a resolvable closure and declared readers", () => {
    const root = path.resolve(import.meta.dir, "..");
    const tests = unlistedTests(
      [...new Bun.Glob("scripts/**/*.test.{ts,sh}").scanSync({ cwd: root })],
      readCiCheckCommandText(root),
    );
    const selection = selectScriptTests({
      tests,
      changed: ["docs/changelog/selection-proof.md"],
      root,
      inputs: scriptTestInputs.inputs,
      exemptions: scriptTestInputs.noTrackedInputs,
    });
    expect(selection.files).toEqual(
      Object.entries(scriptTestInputs.inputs)
        .filter(([, patterns]) => patterns.includes("**"))
        .map(([testFile]) => testFile)
        .filter((testFile) => tests.includes(testFile))
        .toSorted(),
    );
    expect(selection.skipped).toBe(tests.length - selection.files.length);
  }, 30_000);

  test("runs everything when no comparison base is available", () => {
    expect(comparisonBase({})).toBeUndefined();
  });
});
