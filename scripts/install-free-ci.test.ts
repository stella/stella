import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  boundedInstallProblems,
  installWorkflowPolicy,
} from "./ci-install-policy";
import {
  conditionOperands,
  impliesCondition,
  importProblems,
  installFreeInvocations,
  lexShell,
  type Classification,
  type InstallFreeInvocation,
} from "./install-free-ci";

// CI runs this file in "Test install-free CI commands" without the dependency
// install, which the check below enforces for this file too.

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CI_WORKFLOW = ".github/workflows/ci.yml";

test("Windows installs and every explicit CI cold install retain bounded logs", () => {
  for (const file of readdirSync(path.join(REPO_ROOT, ".github/workflows"))) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) {
      continue;
    }
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(path.join(REPO_ROOT, ".github/workflows", file), "utf-8"),
    );
    const policy = installWorkflowPolicy(file);
    switch (policy.type) {
      case "check": {
        expect(boundedInstallProblems(workflow, policy.scope), file).toEqual(
          [],
        );
        break;
      }
      case "pinned-release": {
        expect(policy.reason).toContain("pinned release SHA");
        break;
      }
      default: {
        policy satisfies never;
      }
    }
  }
});

test("the install guard rejects bypasses, unbounded steps and lost logs", () => {
  const upload = {
    uses: "actions/upload-artifact@fixture",
    if: "failure()",
    with: { path: `\${{ runner.temp }}/bun-install/*.log` },
  };
  const install = {
    run: 'bun scripts/ci-install.ts "$RUNNER_TEMP/bun-install/scripts.log" --ignore-scripts',
    "timeout-minutes": 3,
  };
  const workflow = (steps: unknown[]) => ({
    jobs: {
      smoke: { "runs-on": "windows-latest", "timeout-minutes": 10, steps },
    },
  });
  expect(
    boundedInstallProblems(workflow([install, upload]), "windows"),
  ).toEqual([]);
  expect(
    boundedInstallProblems(
      workflow([{ run: "bun install" }, upload]),
      "windows",
    ),
  ).toContain("smoke: install bypasses scripts/ci-install.ts");
  expect(
    boundedInstallProblems(
      workflow([{ parallel: [{ run: "bun install" }] }, upload]),
      "windows",
    ),
  ).toContain("smoke: install bypasses scripts/ci-install.ts");
  expect(
    boundedInstallProblems(
      workflow([{ ...install, "timeout-minutes": 10 }, upload]),
      "windows",
    ),
  ).toContain("smoke: install needs a bounded step timeout");
  expect(boundedInstallProblems(workflow([install]), "windows")).toContain(
    "smoke: install needs a retained failure log",
  );
  const policy = installWorkflowPolicy("new-windows-smoke.yml");
  expect(policy.type).toBe("check");
  if (policy.type !== "check") {
    throw new Error("A new CI workflow must not inherit a release exclusion");
  }
  expect(
    boundedInstallProblems(workflow([{ run: "bun install" }]), policy.scope),
  ).toContain("smoke: install bypasses scripts/ci-install.ts");
});

/** Install-free commands allowed to fetch a package to run it, with why. */
const FETCH_ALLOWLIST: readonly { command: string; reason: string }[] = [];

let fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  fixtureRoots = [];
});

/** Writes a fixture repository and returns its root. */
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), "install-free-ci-"));
  fixtureRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
};

const commands = (source: string): string[] =>
  lexShell(source).flatMap((event) =>
    event.type === "command" ? [event.words.join(" ")] : [],
  );

/** Problems with one invocation; none when it runs from a bare checkout. */
const invocationProblems = (
  root: string,
  { classification, command, job, step }: InstallFreeInvocation,
): string[] => {
  const at = `${job} › ${step}: ${command}`;
  const { type } = classification;
  switch (type) {
    case "files": {
      return importProblems({ entries: classification.entries, root }).map(
        (problem) => `${at}: ${problem}`,
      );
    }
    case "eval": {
      return importProblems({
        code: { cwd: classification.cwd, source: classification.code },
        entries: [],
        root,
      }).map((problem) => `${at}: ${problem}`);
    }
    case "install": {
      return [];
    }
    case "fetch": {
      return FETCH_ALLOWLIST.some((entry) => entry.command === command)
        ? []
        : [`${at}: fetches a package to run it`];
    }
    case "unclassified": {
      return [`${at}: unclassified (${classification.reason})`];
    }
    default: {
      classification satisfies never;
      throw new Error(`Unhandled classification: ${String(type)}`);
    }
  }
};

describe("shell lexing", () => {
  test("keeps ANSI-C escaped quotes, backslashes and newlines in one literal word", () => {
    expect(
      lexShell(
        String.raw`printf '%s' $'src=\'fixture\'; rg literal\\path\n$(rg hidden)'suffix`,
      ),
    ).toEqual([
      {
        type: "command",
        words: [
          "printf",
          "%s",
          "src='fixture'; rg literal\\path\n$(rg hidden)suffix",
        ],
      },
    ]);
    expect(lexShell("printf $'line one\nline two'\ntrue")).toEqual([
      { type: "command", words: ["printf", "line one\nline two"] },
      { type: "command", words: ["true"] },
    ]);
  });

  test("decodes ANSI-C command names without interpreting literal command content", () => {
    for (const escaped of [String.raw`\x72g`, String.raw`\162\147`, "rg"]) {
      expect(lexShell(`$'${escaped}' file`)).toEqual([
        { type: "command", words: ["rg", "file"] },
      ]);
    }
    expect(lexShell(String.raw`printf $'rg\0; hidden' $'\q'`)).toEqual([
      { type: "command", words: ["printf", "rg", String.raw`\q`] },
    ]);
  });

  test("decodes ANSI-C byte escapes and preserves unknown escapes", () => {
    expect(
      lexShell(
        String.raw`printf $'\a\b\e\E\f\n\r\t\v\"' $'\0123\1234\777\x7\x72g\x\z'`,
      ),
    ).toEqual([
      {
        type: "command",
        words: [
          "printf",
          '\u0007\b\u001b\u001b\f\n\r\t\v"',
          "\n3S4\u00ff\u0007rg\\x\\z",
        ],
      },
    ]);
  });

  test("reports unsupported or unterminated ANSI-C literals instead of guessing", () => {
    expect(lexShell(String.raw`printf $'escaped\'`).at(-1)).toEqual({
      type: "unparsed",
      reason: "unterminated ANSI-C quote",
    });
    for (const escape of ["u", "U", "c"]) {
      expect(lexShell(`printf $'\\${escape}72'`).at(-1)).toEqual({
        type: "unparsed",
        reason: `unsupported ANSI-C escape \\${escape}`,
      });
    }
  });

  test("reads quoted, substituted and continued commands", () => {
    expect(
      commands(
        [
          "set -euo pipefail # a comment naming bun x",
          'out=$(bun scripts/a.ts "$x" 2>&1)',
          'read -r -a args <<<"$(bun scripts/b.ts --filters "$SHARD")"',
          "bun scripts/c.ts \\",
          "  --flag 'quoted value'",
          'echo "::warning::Re-run with \\`bun run fix\\`."',
          "grep -q 'bun scripts/not-run.ts' file",
          `curl \${conditional[@]+"\${conditional[@]}"} "$url"`,
          "(cd sub && bun install)",
        ].join("\n"),
      ),
    ).toEqual([
      "set -euo pipefail",
      "bun scripts/a.ts $x",
      "out=$(…)",
      "bun scripts/b.ts --filters $SHARD",
      "read -r -a args",
      "bun scripts/c.ts --flag quoted value",
      "echo ::warning::Re-run with `bun run fix`.",
      "grep -q bun scripts/not-run.ts file",
      `curl \${conditional[@]+"\${conditional[@]}"} $url`,
      "cd sub",
      "bun install",
    ]);
  });

  test("skips heredoc bodies", () => {
    expect(
      commands(
        ["cat <<'EOF' > out.txt", "bun scripts/a.ts", "EOF", "true"].join("\n"),
      ),
    ).toEqual(["cat", "true"]);
  });

  test("keeps only a standard-input heredoc as the command's stdin", () => {
    const stdins = (source: string) =>
      lexShell(source).flatMap((event) =>
        event.type === "command" ? [event.stdin?.body] : [],
      );
    expect(
      stdins(
        [
          "bun - <<'JS'",
          'import "a";',
          "JS",
          "cat <<-EOF",
          "\tindented",
          "\tEOF",
          "bun - 3<<EOF",
          "x",
          "EOF",
          "bun - <<EOF < file",
          "x",
          "EOF",
          "true",
        ].join("\n"),
      ),
    ).toEqual(['import "a";', "indented", undefined, undefined, undefined]);
  });

  test("reports an unterminated quote instead of guessing", () => {
    expect(lexShell("echo 'open").at(-1)).toEqual({
      reason: "unterminated single quote",
      type: "unparsed",
    });
  });

  test("finds every command that starts a line in the CI workflow", () => {
    // Every run line starting with `bun ` must surface as a lexed command, so
    // a lexing mistake cannot hide one from the classification below.
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(path.join(REPO_ROOT, CI_WORKFLOW), "utf-8"),
    );
    const runs: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "run" && typeof child === "string") {
          runs.push(child);
        } else {
          collect(child);
        }
      }
    };
    collect(workflow);
    const missing = runs.flatMap((run) => {
      const lexed = commands(run);
      return run
        .split("\n")
        .map((line) => line.trim().split(/\s+/u).slice(0, 2).join(" "))
        .filter((start) => start.startsWith("bun "))
        .filter((start) => !lexed.some((command) => command.includes(start)));
    });
    expect(runs.length).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});

describe("step conditions", () => {
  test("splits only top-level conjunctions", () => {
    expect(conditionOperands(undefined)).toEqual([]);
    expect(
      conditionOperands(
        `\${{ !cancelled() && needs.plan.outputs.ok == 'true' }}`,
      ),
    ).toEqual(["!cancelled()", "needs.plan.outputs.ok == 'true'"]);
    expect(conditionOperands("a == 'x' || b == 'y' && c")).toEqual([
      "a == 'x' || b == 'y' && c",
    ]);
    expect(conditionOperands("a && (b || c)")).toEqual(["a", "b || c"]);
    expect(conditionOperands("(a &&\n b)")).toEqual(["a", "b"]);
  });

  test("a step is covered only when its condition implies the install's", () => {
    const covers = (step: string | undefined, install: string | undefined) =>
      impliesCondition({
        install: conditionOperands(install),
        step: conditionOperands(step),
      });
    const checks = "needs.plan.outputs.checks == 'true'";

    expect(covers(undefined, undefined)).toBe(true);
    expect(covers(`${checks} && matrix.x`, checks)).toBe(true);
    expect(covers(undefined, checks)).toBe(false);
    expect(covers(`${checks} || always()`, checks)).toBe(false);
    // One alternative of an `||` install condition implies it.
    expect(
      covers(
        "matrix.suite == 'ui' && a == 'true'",
        "a == 'true' || b == 'true'",
      ),
    ).toBe(true);
    expect(covers("matrix.suite == 'ui'", "a == 'true' || b == 'true'")).toBe(
      false,
    );
  });
});

describe("install-free invocation classification", () => {
  const repository = (workflow: string, extra: Record<string, string> = {}) =>
    fixture({
      ".github/workflows/ci.yml": workflow,
      "package.json": JSON.stringify({
        scripts: {
          check: "bun scripts/check.ts && bun test scripts/check.test.ts",
          lint: "oxlint .",
          precheck: "bun scripts/pre.ts",
        },
        workspaces: ["packages/*"],
      }),
      "packages/tool/package.json": JSON.stringify({
        name: "@fixture/tool",
        scripts: { gen: "bun ../tool/gen.ts" },
      }),
      "packages/tool/gen.ts": 'import { z } from "zod";\n',
      "scripts/check.test.ts": 'import { test } from "bun:test";\n',
      "scripts/check.ts":
        'import { readFileSync } from "node:fs";\nimport "./helper";\n',
      "scripts/helper.ts": 'import { panic } from "better-result";\n',
      "scripts/pre.ts": "",
      ...extra,
    });

  const classify = (run: string, extra: Record<string, string> = {}) => {
    const root = repository(
      `jobs:\n  job:\n    steps:\n      - name: Step\n        run: ${JSON.stringify(run)}\n`,
      extra,
    );
    return installFreeInvocations({
      root,
      workflow: ".github/workflows/ci.yml",
    }).map(({ classification, command }) => ({ classification, command }));
  };

  const kinds = (run: string): Classification["type"][] =>
    classify(run).map(({ classification }) => classification.type);

  test("classifies scripts, tests, inline code and package scripts", () => {
    expect(
      classify(
        [
          "bun scripts/check.ts --flag",
          "bun test --timeout 5000 scripts/check.test.ts --preload=./scripts/pre.ts",
          "bun -p 'require(\"./package.json\").name'",
          "bun run check",
          "bun --filter @fixture/tool gen",
        ].join("\n"),
      ),
    ).toEqual([
      {
        classification: {
          cwd: "",
          entries: ["scripts/check.ts"],
          type: "files",
        },
        command: "bun scripts/check.ts --flag",
      },
      {
        classification: {
          cwd: "",
          entries: ["scripts/check.test.ts", "scripts/pre.ts"],
          type: "files",
        },
        command:
          "bun test --timeout 5000 scripts/check.test.ts --preload=./scripts/pre.ts",
      },
      {
        classification: {
          code: 'require("./package.json").name',
          cwd: "",
          type: "eval",
        },
        command: 'bun -p require("./package.json").name',
      },
      {
        classification: { cwd: "", entries: ["scripts/pre.ts"], type: "files" },
        command: "bun run check › precheck: bun scripts/pre.ts",
      },
      {
        classification: {
          cwd: "",
          entries: ["scripts/check.ts"],
          type: "files",
        },
        command: "bun run check › check: bun scripts/check.ts",
      },
      {
        classification: {
          cwd: "",
          entries: ["scripts/check.test.ts"],
          type: "files",
        },
        command: "bun run check › check: bun test scripts/check.test.ts",
      },
      {
        classification: {
          cwd: "packages/tool",
          entries: ["packages/tool/gen.ts"],
          type: "files",
        },
        command: "bun --filter @fixture/tool gen › gen: bun ../tool/gen.ts",
      },
    ]);
  });

  test("fails closed on what it cannot follow", () => {
    expect(
      classify(
        [
          "bunx some-tool",
          "bun x some-tool",
          "npx some-tool",
          "bun --install=force scripts/check.ts",
          "bun test scripts",
          "bun test",
          "bun scripts/missing.ts",
          'bun "$SCRIPT"',
          "bun run lint",
          "bun run absent",
          "bun --filter @fixture/none gen",
          "bun build scripts/check.ts",
          "bun - < scripts/check.ts",
          "bash run-in-image.sh bun scripts/check.ts",
          'cd "$TARGET" && bun scripts/check.ts',
        ].join("\n"),
      ).map(({ classification }) =>
        classification.type === "unclassified"
          ? classification.reason
          : classification.type,
      ),
    ).toEqual([
      "fetch",
      "fetch",
      "fetch",
      "unknown bun flag --install=force",
      "bun test argument scripts is not a test file",
      "bun test without a test file runs every test it finds",
      "scripts/missing.ts does not exist",
      "$SCRIPT is computed at run time",
      "runs oxlint, which the dependency install may provide",
      ".#absent is not a package.json script",
      "--filter @fixture/none names no single workspace package",
      "bun build is not classified",
      "reads code from a non-heredoc stdin",
      "bash runs Bun with arguments this check cannot follow",
      "scripts/check.ts is computed at run time",
    ]);
  });

  test.each([
    "env bunx some-tool",
    "CI=true env -- bunx some-tool",
    "exec env CI=true bun x some-tool",
    "env CI=true npx some-tool",
  ])("classifies package execution through wrappers: %s", (command) => {
    expect(kinds(command)).toEqual(["fetch"]);
  });

  test.each([
    "if false; then bun ci; fi",
    "if false; then out=$(bun ci); fi",
    "if false; then (bun ci); fi",
    "(false && bun ci)",
    ...["&& true", "|| true", "&", "| cat"].flatMap((operator) => [
      `(bun ci) ${operator}`,
      `{ bun ci; } ${operator}`,
      `({ bun ci; }) ${operator}`,
    ]),
    "false && bun ci",
    "bun ci || true",
    "for item in; do bun ci; done",
    "bun ci &",
    "bun ci | cat",
    "! bun ci",
  ])("shell control flow cannot establish install coverage: %s", (install) => {
    expect(kinds(`${install}\nbun scripts/check.ts`)).toEqual([
      "install",
      "files",
    ]);
  });

  test.each(["test -d node_modules || bun install", "bun install || true"])(
    "nested script control flow cannot establish install coverage: %s",
    (setup) => {
      const root = repository(
        [
          "jobs:",
          "  job:",
          "    steps:",
          "      - run: bun run setup; bun scripts/check.ts",
          "      - run: bun scripts/check.ts",
        ].join("\n"),
        {
          "package.json": JSON.stringify({
            scripts: { setup: "bun run inner", inner: setup },
          }),
        },
      );
      expect(
        installFreeInvocations({ root, workflow: CI_WORKFLOW }).map(
          ({ classification }) => classification.type,
        ),
      ).toEqual(["install", "files", "files"]);
    },
  );

  test("straight-line nested installs retain coverage", () => {
    expect(
      classify("bun run setup; bun scripts/missing.ts", {
        "package.json": JSON.stringify({
          scripts: { setup: "bun run inner", inner: "bun ci" },
        }),
      }).map(({ classification }) => classification.type),
    ).toEqual(["install"]);
    expect(kinds("{ bun ci; }\nbun scripts/missing.ts")).toEqual(["install"]);
  });

  test.each([
    'bash -c "bun scripts/check.ts"',
    "sh -c 'bunx some-tool'",
    "bash -lc 'env npx some-tool'",
    `sh -c 'bash -c "bun scripts/check.ts"'`,
    `bash -c 'bun "'`,
    'sh -c "$SCRIPT"',
  ])("reports Bun or unparseable shell command strings: %s", (command) => {
    expect(kinds(command)).toEqual(["unclassified"]);
  });

  test.each([
    'echo "bun scripts/check.ts"',
    `bash -c 'echo "bun scripts/check.ts"'`,
    "sh -c 'echo bunx some-tool'",
  ])("ignores Bun names in shell output: %s", (command) => {
    expect(kinds(command)).toEqual([]);
  });

  test("unconditional installs retain coverage across later control flow", () => {
    expect(kinds("bun ci\nif true; then bun scripts/missing.ts; fi")).toEqual([
      "install",
    ]);
    expect(
      kinds("(if false; then bun ci; fi)\n(bun ci; bun scripts/missing.ts)"),
    ).toEqual(["install", "install"]);
  });

  test("a conditional shell install cannot cover a later workflow step", () => {
    const root = repository(
      [
        "jobs:",
        "  job:",
        "    steps:",
        "      - run: if false; then bun ci; fi",
        "      - run: bun scripts/check.ts",
      ].join("\n"),
    );
    expect(
      installFreeInvocations({ root, workflow: CI_WORKFLOW }).map(
        ({ classification }) => classification.type,
      ),
    ).toEqual(["install", "files"]);
  });

  test("commands after an install in the same directory are covered", () => {
    expect(
      kinds(
        [
          "bun scripts/check.ts",
          "bash scripts/retry.sh bun ci --ignore-scripts",
          "bun scripts/missing.ts",
        ].join("\n"),
      ),
    ).toEqual(["files", "install"]);
    expect(
      kinds(
        [
          "bun install -g turbo",
          "(cd scratch; bun install)",
          "bun scripts/check.ts",
          "(cd scratch && bun scripts/missing.ts)",
        ].join("\n"),
      ),
    ).toEqual(["install", "install", "files"]);
  });

  test("parallel siblings share only the installs available before the group", () => {
    const root = repository(
      [
        "jobs:",
        "  job:",
        "    steps:",
        "      - parallel:",
        "          - run: bun ci",
        "          - parallel:",
        "              - name: Nested invocation",
        "                run: bun scripts/check.ts",
        "      - name: After group",
        "        run: bun scripts/check.ts",
      ].join("\n"),
    );
    const invocations = installFreeInvocations({
      root,
      workflow: CI_WORKFLOW,
    });
    const files = invocations.filter(
      ({ classification }) => classification.type === "files",
    );
    expect(files).toHaveLength(1);
    expect(files.at(0)?.step).toBe("Nested invocation");
  });

  test("a parallel group waits for background installs without sharing them with siblings", () => {
    const root = repository(
      [
        "jobs:",
        "  job:",
        "    steps:",
        "      - parallel:",
        "          - id: installed",
        "            background: true",
        "            run: bun ci",
        "          - name: Concurrent invocation",
        "            run: bun scripts/check.ts",
        "      - name: After group",
        "        run: bun scripts/check.ts",
      ].join("\n"),
    );
    const files = installFreeInvocations({
      root,
      workflow: CI_WORKFLOW,
    }).filter(({ classification }) => classification.type === "files");
    expect(files).toHaveLength(1);
    expect(files.at(0)?.step).toBe("Concurrent invocation");
  });

  test("a background install covers commands only after its wait", () => {
    const root = repository(
      [
        "jobs:",
        "  job:",
        "    steps:",
        "      - id: installed",
        "        background: true",
        "        run: bun ci",
        "      - name: Before wait",
        "        run: bun scripts/check.ts",
        "      - wait: installed",
        "      - name: After wait",
        "        run: bun scripts/check.ts",
      ].join("\n"),
    );
    const files = installFreeInvocations({
      root,
      workflow: CI_WORKFLOW,
    }).filter(({ classification }) => classification.type === "files");
    expect(files).toHaveLength(1);
    expect(files.at(0)?.step).toBe("Before wait");
  });

  test("cancelled background installs stay unavailable after a wait barrier", () => {
    for (const barrier of ["- wait: cancelled", "- wait-all: null"]) {
      const root = repository(
        [
          "jobs:",
          "  job:",
          "    steps:",
          "      - id: cancelled",
          "        background: true",
          "        run: bun ci",
          "      - cancel: cancelled",
          `      ${barrier}`,
          "      - name: After cancel",
          "        run: bun scripts/check.ts",
          "      - id: retained",
          "        background: true",
          "        run: bun ci",
          "      - wait: retained",
          "      - name: After retained wait",
          "        run: bun scripts/check.ts",
        ].join("\n"),
      );
      const files = installFreeInvocations({
        root,
        workflow: CI_WORKFLOW,
      }).filter(({ classification }) => classification.type === "files");
      expect(files, barrier).toHaveLength(1);
      expect(files.at(0)?.step, barrier).toBe("After cancel");
    }
  });

  test("parallel cancellation dominates sibling waits and nested group proofs without losing other scopes", () => {
    for (const installLocation of ["before-group", "nested-sibling"] as const) {
      for (const depth of [0, 1, 2]) {
        for (const siblingWaitPosition of [
          "absent",
          "before",
          "after",
        ] as const) {
          for (const barrier of ["wait: tools", "wait-all: null"]) {
            const cancelBranch = [
              ...Array.from(
                { length: depth },
                (_, index) => `${"  ".repeat(index)}- parallel:`,
              ),
              `${"  ".repeat(depth)}- cancel: tools`,
            ].join("\n");
            const siblingWait = "- wait: tools";
            const installerBranch = [
              "- parallel:",
              "  - id: tools",
              "    background: true",
              "    run: bun ci",
            ].join("\n");
            const parallelBranches = [cancelBranch];
            if (siblingWaitPosition === "before") {
              parallelBranches.unshift(siblingWait);
            }
            if (siblingWaitPosition === "after") {
              parallelBranches.push(siblingWait);
            }
            if (installLocation === "nested-sibling") {
              parallelBranches.unshift(installerBranch);
            }
            const parallelSteps = parallelBranches
              .flatMap((branch) =>
                branch.split("\n").map((line) => `          ${line}`),
              )
              .join("\n");
            const root = repository(
              [
                "jobs:",
                "  job:",
                "    steps:",
                "      - id: retained",
                "        background: true",
                "        run: bun ci",
                "        working-directory: packages/tool",
                "      - wait: retained",
                ...(installLocation === "before-group"
                  ? [
                      "      - id: tools",
                      "        background: true",
                      "        run: bun ci",
                    ]
                  : []),
                "      - parallel:",
                parallelSteps,
                `      - ${barrier}`,
                "      - name: After cancel",
                "        run: bun scripts/check.ts",
                "      - name: Retained install scope",
                "        run: bun gen.ts",
                "        working-directory: packages/tool",
              ].join("\n"),
            );
            const files = installFreeInvocations({
              root,
              workflow: CI_WORKFLOW,
            }).filter(({ classification }) => classification.type === "files");
            const scenario = {
              installLocation,
              depth,
              siblingWaitPosition,
              barrier,
            };
            expect(files, JSON.stringify(scenario)).toHaveLength(1);
            expect(files.at(0)?.step, JSON.stringify(scenario)).toBe(
              "After cancel",
            );
          }
        }
      }
    }
  });

  const continuationCases: readonly {
    continuation: string;
    kinds: Classification["type"][];
  }[] = [
    { continuation: "true", kinds: ["install", "files"] },
    { continuation: `\${{ inputs.optional }}`, kinds: ["install", "files"] },
    { continuation: "false", kinds: ["install"] },
  ];
  test.each(continuationCases)(
    "an install with continue-on-error $continuation covers only successful steps",
    ({ continuation, kinds: expectedKinds }) => {
      for (const directive of [
        "run: bun ci",
        "uses: ./.github/actions/install",
      ]) {
        const root = repository(
          [
            "jobs:",
            "  job:",
            "    steps:",
            `      - ${directive}`,
            `        continue-on-error: ${continuation}`,
            "      - run: bun scripts/check.ts",
          ].join("\n"),
          {
            ".github/actions/install/action.yml":
              "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun ci\n",
          },
        );
        expect(
          installFreeInvocations({ root, workflow: CI_WORKFLOW }).map(
            ({ classification }) => classification.type,
          ),
          directive,
        ).toEqual(expectedKinds);
      }
    },
  );

  test("a later step is covered only by an install its condition implies", () => {
    const root = repository(
      [
        "jobs:",
        "  job:",
        "    steps:",
        "      - name: Before",
        "        run: bun scripts/check.ts",
        "      - name: Install",
        "        if: needs.plan.outputs.checks == 'true'",
        "        run: bun ci",
        "      - name: Gated",
        "        if: needs.plan.outputs.checks == 'true' && matrix.x == 'a'",
        "        run: bun scripts/missing.ts",
        "      - name: Ungated",
        "        run: bun scripts/check.ts",
        "      - name: Other gate",
        "        if: needs.plan.outputs.other == 'true'",
        "        run: bun scripts/check.ts",
        "  composite:",
        "    steps:",
        "      - uses: ./.github/actions/setup",
        "      - name: After action",
        "        run: bun scripts/missing.ts",
        "  conditional-composite:",
        "    steps:",
        "      - uses: ./.github/actions/maybe-setup",
        "      - name: After conditional action",
        "        run: bun scripts/check.ts",
        "  called:",
        "    uses: ./.github/workflows/called.yml",
      ].join("\n"),
      {
        ".github/actions/maybe-setup/action.yml": [
          "runs:",
          "  using: composite",
          "  steps:",
          "    - if: inputs.install == 'true'",
          "      shell: bash",
          "      run: bun ci",
        ].join("\n"),
        ".github/actions/setup/action.yml": [
          "runs:",
          "  using: composite",
          "  steps:",
          "    - name: Inner check",
          "      shell: bash",
          "      run: bun scripts/check.ts",
          "    - name: Install",
          "      shell: bash",
          "      run: bun ci",
        ].join("\n"),
        ".github/workflows/called.yml": [
          "on: workflow_call",
          "jobs:",
          "  inner:",
          "    steps:",
          "      - name: Called step",
          "        run: bun scripts/check.ts",
        ].join("\n"),
      },
    );

    expect(
      installFreeInvocations({
        root,
        workflow: ".github/workflows/ci.yml",
      }).map(
        ({ classification, job, step }) =>
          `${job} | ${step} | ${classification.type}`,
      ),
    ).toEqual([
      "job | Before | files",
      "job | Install | install",
      "job | Ungated | files",
      "job | Other gate | files",
      "composite | ./.github/actions/setup › Inner check | files",
      "composite | ./.github/actions/setup › Install | install",
      "conditional-composite | ./.github/actions/maybe-setup › step 1 | install",
      "conditional-composite | After conditional action | files",
      "called › inner | Called step | files",
    ]);
  });

  test.each([
    { guard: "steps.install.outcome == 'success'", covered: true },
    {
      guard: "!cancelled() && (steps.install.outcome == 'success')",
      covered: true,
    },
    { guard: "steps.install.outcome == 'failure'", covered: false },
    { guard: "steps.install.outcome == 'skipped'", covered: false },
    { guard: "steps.install.conclusion == 'success'", covered: false },
    { guard: "steps.other.outcome == 'success'", covered: false },
    { guard: "steps.install.outcome == 'success' || always()", covered: false },
    {
      guard:
        "(steps.install.outcome == 'success' && matrix.a) || (steps.install.outcome == 'success' && matrix.b)",
      covered: true,
    },
  ])(
    "successful install outcomes establish coverage: $guard",
    ({ guard, covered }) => {
      for (const continuation of ["false", "true", `\${{ inputs.optional }}`]) {
        for (const directive of [
          "run: bun ci",
          "uses: ./.github/actions/install",
        ]) {
          const root = repository(
            [
              "jobs:",
              "  job:",
              "    steps:",
              `      - ${directive}`,
              "        id: install",
              `        if: \${{ !cancelled() && steps.checkout.outcome == 'success' && inputs.checks }}`,
              `        continue-on-error: ${continuation}`,
              "      - run: bun scripts/check.ts",
              `        if: \${{ ${guard} }}`,
            ].join("\n"),
            {
              ".github/actions/install/action.yml":
                "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun ci\n",
            },
          );
          expect(
            installFreeInvocations({ root, workflow: CI_WORKFLOW }).map(
              ({ classification }) => classification.type,
            ),
            `${directive}; continue-on-error: ${continuation}`,
          ).toEqual(covered ? ["install"] : ["install", "files"]);
        }
      }
    },
  );

  test.each([
    "if false; then bun ci; fi",
    "bun ci || true",
    "bun install -g turbo",
  ])(
    "a successful step cannot prove a conditional or global install: %s",
    (run) => {
      const root = repository(
        [
          "jobs:",
          "  job:",
          "    steps:",
          `      - run: ${run}`,
          "        id: install",
          "        continue-on-error: true",
          "      - run: bun scripts/check.ts",
          "        if: steps.install.outcome == 'success'",
        ].join("\n"),
      );
      expect(
        installFreeInvocations({ root, workflow: CI_WORKFLOW }).map(
          ({ classification }) => classification.type,
        ),
      ).toEqual(["install", "files"]);
    },
  );

  test("successful outcome coverage stays in the installed directory and composite scope", () => {
    const root = repository(
      [
        "jobs:",
        "  job:",
        "    steps:",
        "      - uses: ./.github/actions/install",
        "        id: setup",
        "      - run: bun packages/tool/gen.ts",
        "        working-directory: packages/tool",
        "        if: steps.setup.outcome == 'success'",
        "      - run: bun scripts/check.ts",
        "        if: steps.setup.outcome == 'success'",
        "      - run: bun packages/tool/gen.ts",
        "        if: steps.install.outcome == 'success'",
      ].join("\n"),
      {
        ".github/actions/install/action.yml": [
          "runs:",
          "  using: composite",
          "  steps:",
          "    - run: bun ci",
          "      shell: bash",
          "      id: install",
          "      working-directory: packages/tool",
          "    - run: bun gen.ts",
          "      shell: bash",
          "      working-directory: packages/tool",
          "      if: steps.install.outcome == 'success'",
        ].join("\n"),
      },
    );
    expect(
      installFreeInvocations({ root, workflow: CI_WORKFLOW }).map(
        ({ classification }) => classification.type,
      ),
    ).toEqual(["install", "files", "files"]);
  });

  test("checks code a heredoc feeds to `bun -` like inline code", () => {
    expect(
      classify(
        ["bun --no-env-file - <<'JS'", 'import { z } from "zod";', "JS"].join(
          "\n",
        ),
      ),
    ).toEqual([
      {
        classification: {
          code: 'import { z } from "zod";',
          cwd: "",
          type: "eval",
        },
        command: "bun --no-env-file -",
      },
    ]);
    expect(
      kinds(["bun -r ./scripts/pre.ts - <<'JS'", "1", "JS"].join("\n")),
    ).toEqual(["unclassified"]);
  });

  test("reports every installed package a file or inline code imports", () => {
    const root = repository("jobs: {}\n");

    expect(importProblems({ entries: ["scripts/check.ts"], root })).toEqual([
      "scripts/helper.ts imports better-result",
    ]);
    expect(
      importProblems({
        code: { cwd: "", source: 'require("./package.json"); require("zod");' },
        entries: [],
        root,
      }),
    ).toEqual(["inline code in . imports zod"]);
    expect(
      importProblems({ entries: ["scripts/check.test.ts"], root }),
    ).toEqual([]);
  });
  test("bounded installs and planner calls retain dependency coverage", () => {
    for (const prefix of [
      ...["0", "1.5", ".5", "1.", "2s", "3.5m", "4h", "5d"].map(
        (duration) => `timeout ${duration}`,
      ),
      "timeout 120s",
      "timeout --kill-after=10s 120s",
      "timeout -k 10s 120s",
      "timeout --signal TERM -- 120s",
    ]) {
      const root = repository(
        [
          "jobs:",
          "  job:",
          "    steps:",
          `      - run: bash scripts/retry.sh ${prefix} bun ci --ignore-scripts`,
          "        id: installed",
          "        if: inputs.run == true",
          `      - run: ${prefix} bun scripts/check.ts`,
          "        if: steps.installed.outcome == 'success'",
        ].join("\n"),
      );
      expect(
        installFreeInvocations({ root, workflow: CI_WORKFLOW }).map(
          ({ classification }) => classification.type,
        ),
      ).toEqual(["install"]);
      expect(
        classify(`${prefix} bun scripts/check.ts`).map(
          ({ classification }) => classification.type,
        ),
      ).toEqual(["files"]);
    }
  });

  test("timeout invalid durations and options cannot certify dependency installation", () => {
    for (const option of [
      "--help",
      "--version",
      "--unknown",
      "invalid",
      "1ss",
      "1..5",
      "1x",
      "-1",
      "--kill-after=invalid 120s",
      "-k invalid 120s",
      "-kinvalid 120s",
    ]) {
      const root = repository(
        [
          "jobs:",
          "  job:",
          "    steps:",
          `      - run: timeout ${option} bun ci`,
          "        id: installed",
          "      - run: bun scripts/check.ts",
          "        if: steps.installed.outcome == 'success'",
        ].join("\n"),
      );
      const invocations = installFreeInvocations({
        root,
        workflow: CI_WORKFLOW,
      });
      expect(
        invocations.some(
          ({ classification }) => classification.type === "install",
        ),
      ).toBe(false);
      expect(
        invocations.some(
          ({ classification }) =>
            classification.type === "files" &&
            classification.entries.includes("scripts/check.ts"),
        ),
      ).toBe(true);
    }
  });
});

test("everything CI runs without the dependency install imports only built-ins", () => {
  const invocations = installFreeInvocations({
    root: REPO_ROOT,
    workflow: CI_WORKFLOW,
  });
  const loaded = new Set(
    invocations.flatMap(({ classification }) =>
      classification.type === "files" ? classification.entries : [],
    ),
  );
  // The walk reaches the steps that are install-free on purpose, this guard
  // among them, so a broken walk cannot pass by finding nothing.
  for (const file of [
    "scripts/check-api-deployment.test.ts",
    "scripts/check-standalone-lockfiles.ts",
    "scripts/detect-e2e-changes.test.ts",
    "scripts/install-free-ci.test.ts",
  ]) {
    expect(loaded).toContain(file);
  }
  expect(
    invocations.some(({ command }) =>
      command.startsWith("bun run policies:check › "),
    ),
  ).toBe(true);
  for (const entry of FETCH_ALLOWLIST) {
    expect(invocations.map(({ command }) => command)).toContain(entry.command);
  }

  expect(
    invocations.flatMap((invocation) =>
      invocationProblems(REPO_ROOT, invocation),
    ),
  ).toEqual([]);
});

// Bun commands that cannot fetch a package: lockfile operations and runs that
// disable auto-install explicitly.
const NO_FETCH_COMMAND =
  /^bun(?:\s+--[\w-]+)*\s+(?:dedupe\b|[^\n]*--no-install\b)/u;

test("every workflow's install-free Bun commands load only built-ins", () => {
  const workflows = readdirSync(path.join(REPO_ROOT, ".github/workflows"))
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => `.github/workflows/${name}`);
  expect(workflows).toContain(CI_WORKFLOW);
  const problems = workflows.flatMap((workflow) =>
    installFreeInvocations({ root: REPO_ROOT, workflow }).flatMap(
      (invocation) =>
        invocation.classification.type === "unclassified" &&
        NO_FETCH_COMMAND.test(invocation.command)
          ? []
          : invocationProblems(REPO_ROOT, invocation).map(
              (problem) => `${workflow}: ${problem}`,
            ),
    ),
  );
  expect(problems).toEqual([]);
});
