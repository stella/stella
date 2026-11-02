import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SAFE_AUTOFIX_RULES } from "./autofix-safe-rules";
import {
  hasTypeAwareCandidate,
  TYPE_AWARE_SAFE_RULE_CANDIDATES,
} from "./autofix-type-aware-precheck";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const cases = [
  { name: "complete types", failure: "none", extra: "" },
  { name: "excluded source", failure: "coverage", extra: "" },
  { name: "missing project", failure: "project", extra: "" },
  {
    name: "unresolved import",
    failure: "types",
    extra:
      'import { missing } from "./absent";\nexport const broken = missing;\n',
  },
  {
    name: "invalid imported types",
    failure: "types",
    extra:
      'import { broken } from "./dependency";\nexport const bad = broken;\n',
  },
  {
    name: "failed generated-source preparation",
    failure: "prepare",
    extra: "",
  },
  // Nothing to fix: no safe rule reports the file without types, so the type
  // graph is not prepared and its project is not checked, even with a type
  // error CI's typecheck reports instead.
  {
    name: "no fixable finding",
    failure: "unfixed",
    extra:
      'import { missing } from "./absent";\nexport const broken = missing;\n',
  },
  // A syntactic pre-check that cannot finish takes the full type-aware path.
  { name: "failed syntactic pre-check", failure: "precheck", extra: "" },
] as const;

test.each(cases)(
  "type-aware fixes require $name, exclude generated text, and leave unchanged files byte-identical",
  ({ failure, extra }) => {
    const root = mkdtempSync(path.join(tmpdir(), "autofix-type-aware-"));
    const repo = path.resolve(import.meta.dirname, "..");
    const fixable =
      'export const value = { name: "fixture" };\nexport const name = value["name"];\n';
    const guarded = `${fixable}export const truth = value.name ? true : false;\nexport const reversed = 1 === value.name.length;\ndebugger;\n`;
    const clean = failure === "unfixed" || failure === "precheck";
    const source = clean
      ? fixable.replace('value["name"]', "value.name")
      : guarded;
    try {
      symlinkSync(
        path.join(repo, "node_modules"),
        path.join(root, "node_modules"),
      );
      mkdirSync(path.join(root, "bin"));
      mkdirSync(path.join(root, "scripts"));
      for (const file of [
        "autofix-safe-rules.ts",
        "autofix-protected-paths.ts",
        "autofix-type-aware-precheck.ts",
        "baseline-paths.ts",
        "typecheck-coverage.ts",
      ]) {
        writeFileSync(
          path.join(root, "scripts", file),
          readFileSync(new URL(file, import.meta.url)),
        );
      }
      mkdirSync(path.join(root, "packages/scripts/src"), { recursive: true });
      for (const file of [
        "tsc-native.ts",
        "child-exit-status.ts",
        "syntax-tree.ts",
      ]) {
        writeFileSync(
          path.join(root, "packages/scripts/src", file),
          readFileSync(path.join(repo, "packages/scripts/src", file)),
        );
      }
      writeFileSync(path.join(root, "changed.ts"), source + extra);
      if (extra.includes("dependency")) {
        writeFileSync(
          path.join(root, "dependency.ts"),
          'export const broken: number = "wrong";\n',
        );
      }
      writeFileSync(path.join(root, "unchanged.ts"), source);
      if (failure !== "project") {
        writeFileSync(
          path.join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              target: "ESNext",
              module: "ESNext",
            },
            include: failure === "coverage" ? ["unchanged.ts"] : ["*.ts"],
          }),
        );
      }
      writeFileSync(
        path.join(root, "oxlint.config.ts"),
        'export default { plugins: ["typescript"], categories: { correctness: "off" }, rules: { "typescript/dot-notation": "error", "no-debugger": "error", "no-unneeded-ternary": "error", "yoda": "error" } };\n',
      );
      for (const file of [
        "bunfig.toml",
        ".editorconfig",
        "package.json",
        ".prettierrc.yml",
      ]) {
        copyFileSync(path.join(repo, file), path.join(root, file));
      }
      mkdirSync(path.join(root, "apps/landing"), { recursive: true });
      const imports =
        'import {z} from "z-package";import {a} from "a-package";export const names=[z,a]';
      writeFileSync(path.join(root, "apps/landing/changed.js"), imports);
      writeFileSync(path.join(root, "unchanged.js"), imports);
      writeFileSync(path.join(root, "changed.json"), '{"x":1,"y":[2,3]}');
      writeFileSync(path.join(root, "generated.html.txt"), "fixture");
      // The fixer steps read the push scope; a run without a settled
      // commit scopes every changed path.
      for (const name of ["autofix-changed-paths", "autofix-fix-paths"]) {
        writeFileSync(
          path.join(root, name),
          "changed.ts\0generated.html.txt\0apps/landing/changed.js\0changed.json\0",
        );
      }
      const finding = Bun.spawnSync(
        [
          process.execPath,
          "--bun",
          "oxlint",
          "-c",
          "oxlint.config.ts",
          "--type-aware",
          "changed.ts",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      if (!clean) {
        expect(finding.exitCode).toBe(1);
        expect(finding.stdout.toString() + finding.stderr.toString()).toContain(
          "dot-notation",
        );
      }
      // Generated-source production is covered by its own integration tests;
      // this fixture verifies that the workflow prepares before the real lint fix.
      writeFileSync(
        path.join(root, "bin/bun"),
        `#!/bin/bash
if [[ "$1" == scripts/ci-generated-sources.ts && "$2" == prepare ]]; then touch prepared; exit "$PREPARE_EXIT"; fi
if [[ "$1" == scripts/autofix-plan.ts && "$2" == run ]]; then cp changed.ts generated.html.txt; exit 0; fi
if [[ "$2" == oxlint && "$*" != *--type-aware* && -n "$PRECHECK_EXIT" ]]; then exit "$PRECHECK_EXIT"; fi
if [[ "$2" == oxlint && "$*" == *--type-aware* && ! -f prepared ]]; then exit 2; fi
if [[ "$1" == scripts/typecheck-coverage.ts && "$2" == --autofix ]]; then touch compiler_checked; printf '%s\\n' "$@" > compiler_args; fi
if [[ "$*" == *" --fix "* ]]; then touch fixer_ran; fi
exec '${process.execPath}' "$@"
`,
        { mode: 0o755 },
      );
      const workflow = readFileSync(
        new URL("../.github/workflows/autofix.yml", import.meta.url),
        "utf-8",
      );
      const steps = workflowJobSteps(
        Bun.YAML.parse(workflow),
        "regenerate-derived-files",
      );
      const pipeline = steps.filter(
        (step) =>
          step === workflowStepByName(steps, "Fix changed files") ||
          step === workflowStepByName(steps, "Regenerate selected files"),
      );
      const command = pipeline
        .map((step) => {
          if (typeof step["run"] !== "string") {
            throw new TypeError("Autofix step requires a run command");
          }
          return step["run"];
        })
        .join("\n");
      const fixed = Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          GENERATOR_IDS: "fixture",
          PREPARE_EXIT: failure === "prepare" ? "1" : "0",
          PRECHECK_EXIT: failure === "precheck" ? "2" : "",
          PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (failure === "none") {
        expect(
          fixed.exitCode,
          fixed.stdout.toString() + fixed.stderr.toString(),
        ).toBe(0);
        expect(readFileSync(path.join(root, "changed.ts"), "utf-8")).toBe(
          source.replace('value["name"]', "value.name"),
        );
      } else if (clean) {
        expect(
          fixed.exitCode,
          fixed.stdout.toString() + fixed.stderr.toString(),
        ).toBe(0);
        expect(readFileSync(path.join(root, "changed.ts"), "utf-8")).toBe(
          source + extra,
        );
      } else {
        // Preparation errors stop the step; a fix its project rejects only
        // drops the lint rewrites, so formatting and generators still run.
        if (failure === "prepare") {
          expect(fixed.exitCode).not.toBe(0);
        } else {
          expect(
            fixed.exitCode,
            fixed.stdout.toString() + fixed.stderr.toString(),
          ).toBe(0);
          expect(fixed.stdout.toString()).toContain(
            "::warning title=Autofix lint fixes dropped::",
          );
        }
        expect(readFileSync(path.join(root, "changed.ts"), "utf-8")).toBe(
          source + extra,
        );
        // Preparation fails before the fixer; every later failure restores the
        // fixer's rewrites, so the source above stays byte-identical.
        if (failure === "coverage") {
          expect(fixed.stdout.toString() + fixed.stderr.toString()).toContain(
            "covered by no candidate project",
          );
        }
        if (failure === "project") {
          expect(fixed.stdout.toString() + fixed.stderr.toString()).toContain(
            "no TypeScript project",
          );
        }
        if (failure === "types") {
          expect(fixed.stdout.toString() + fixed.stderr.toString()).toMatch(
            /TS(?:2307|2322)/u,
          );
        }
      }
      expect(existsSync(path.join(root, "compiler_checked"))).toBe(
        failure !== "prepare" && !clean,
      );
      // Only a clean syntactic pre-check skips the type graph and the
      // type-aware fixer; a finding or a failed pre-check prepares both.
      expect(existsSync(path.join(root, "prepared"))).toBe(
        failure !== "unfixed",
      );
      expect(existsSync(path.join(root, "fixer_ran"))).toBe(
        failure !== "unfixed" && failure !== "prepare",
      );
      if (failure !== "prepare" && !clean) {
        expect(
          readFileSync(path.join(root, "compiler_args"), "utf-8"),
        ).not.toContain("generated.html.txt");
      }
      const generated = readFileSync(
        path.join(root, "generated.html.txt"),
        "utf-8",
      );
      if (failure === "none") {
        const rewritten = readFileSync(path.join(root, "changed.ts"), "utf-8");
        expect(rewritten).not.toBe(source);
        expect(generated).toBe(rewritten);
      } else if (failure === "prepare") {
        expect(generated).toBe("fixture");
      } else {
        // Unfixed sources and rejected fixes both regenerate from the
        // byte-identical source.
        expect(generated).toBe(source + extra);
      }
      expect(readFileSync(path.join(root, "unchanged.js"), "utf-8")).toBe(
        imports,
      );
      if (failure === "none") {
        // Real oxfmt proves both changed-file formatting and configured sorting.
        expect(readFileSync(path.join(root, "changed.json"), "utf-8")).toBe(
          '{ "x": 1, "y": [2, 3] }\n',
        );
        const sorted = readFileSync(
          path.join(root, "apps/landing/changed.js"),
          "utf-8",
        );
        expect(sorted).toBe(
          'import { a } from "a-package";\nimport { z } from "z-package";\nexport const names = [z, a];\n',
        );
      }
      expect(readFileSync(path.join(root, "unchanged.ts"), "utf-8")).toBe(
        source,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const projectCases = [
  { name: "nearest project covers sources", layout: "nearest", invalid: false },
  {
    name: "exempt rule fixtures are skipped beside checked sources",
    layout: "nearest",
    invalid: false,
  },
  {
    name: "included exempt fixtures are still type-checked",
    layout: "nearest",
    invalid: false,
  },
  {
    name: "sibling project covers root sources",
    layout: "sibling",
    invalid: false,
  },
  {
    name: "sibling project reports type errors",
    layout: "sibling",
    invalid: true,
  },
  {
    name: "unrelated errors in a nearer project do not stop the search",
    layout: "sibling-after-broken-nearest",
    invalid: false,
  },
  {
    name: "symlinked sibling project covers root sources",
    layout: "symlinked-sibling",
    invalid: false,
  },
  {
    name: "nested sibling project below the nearest conventional config",
    layout: "nested-sibling",
    invalid: false,
  },
  {
    name: "ancestor project covers nested sources",
    layout: "ancestor",
    invalid: false,
  },
  {
    name: "no project covers sources and names candidates",
    layout: "uncovered",
    invalid: false,
  },
] as const;

test.each(projectCases)("autofix $name", ({ name, layout, invalid }) => {
  // An invalid lint-rule fixture rides along with the sources. When no
  // project includes it, autofix skips it as the coverage check exempts it;
  // when the covering project includes it, its errors still fail the run.
  const includeFixture = name.startsWith("included exempt");
  const exemptFixture =
    name.startsWith("exempt") || includeFixture
      ? ".oxlint-plugins/__fixtures__/bad.fixture.ts"
      : undefined;
  const root = mkdtempSync(path.join(tmpdir(), "autofix-project-"));
  const repo = path.resolve(import.meta.dirname, "..");
  try {
    symlinkSync(
      path.join(repo, "node_modules"),
      path.join(root, "node_modules"),
    );
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/typecheck-coverage.ts"),
      readFileSync(new URL("typecheck-coverage.ts", import.meta.url)),
    );
    mkdirSync(path.join(root, "packages/scripts/src"), { recursive: true });
    for (const file of ["tsc-native.ts", "child-exit-status.ts"]) {
      writeFileSync(
        path.join(root, "packages/scripts/src", file),
        readFileSync(path.join(repo, "packages/scripts/src", file)),
      );
    }
    const compilerPath = path.join(root, "packages/scripts/src/tsc-native.ts");
    writeFileSync(
      path.join(root, "packages/scripts/src/tsc-native-real.ts"),
      readFileSync(compilerPath),
    );
    writeFileSync(
      compilerPath,
      `
import { appendFileSync } from "node:fs";
appendFileSync("compiler-projects", process.argv.at(-1) + "\\n");
const result = Bun.spawnSync([
  process.execPath,
  new URL("./tsc-native-real.ts", import.meta.url).pathname,
  ...process.argv.slice(2),
], { stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
`,
    );
    writeFileSync(
      path.join(root, "fixture-base.json"),
      JSON.stringify({ compilerOptions: { types: [] } }),
    );
    const emptyProject = { extends: "./fixture-base.json", files: [] };
    const directory =
      layout === "ancestor" || layout === "nested-sibling" ? "nested/" : "";
    if (directory) {
      mkdirSync(path.join(root, directory));
    }
    if (layout === "ancestor") {
      writeFileSync(
        path.join(root, directory, "tsconfig.json"),
        JSON.stringify({ extends: "../fixture-base.json", files: [] }),
      );
    }
    const file = `${directory}oxlint.config.ts`;
    const second = `${directory}other.ts`;
    writeFileSync(
      path.join(root, file),
      invalid
        ? 'export const value: number = "wrong";'
        : "export const value: number = 1;",
    );
    writeFileSync(path.join(root, second), "export const other = 2;");
    const compilerOptions = { strict: true, types: [], target: "ESNext" };
    const config = {
      compilerOptions,
      files:
        includeFixture && exemptFixture
          ? [file, second, exemptFixture]
          : [file, second],
    };
    // The nearest project fails to compile on a file the targets do not need.
    writeFileSync(
      path.join(root, "broken.ts"),
      'export const broken: number = "wrong";',
    );
    const nearestProjects: Partial<Record<typeof layout, object>> = {
      nearest: config,
      "sibling-after-broken-nearest": { compilerOptions, files: ["broken.ts"] },
    };
    const nearestProject = nearestProjects[layout] ?? emptyProject;
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify(nearestProject),
    );
    const rootSiblingEmpty =
      layout === "uncovered" || layout === "nested-sibling";
    const siblingProject = JSON.stringify(
      rootSiblingEmpty ? emptyProject : config,
    );
    if (layout === "nested-sibling") {
      // Only a non-conventional config beside the sources covers them; there
      // is no nested tsconfig.json between them and the empty root config.
      writeFileSync(
        path.join(root, directory, "tsconfig.plugins.json"),
        JSON.stringify({
          extends: "../fixture-base.json",
          compilerOptions,
          files: ["oxlint.config.ts", "other.ts"],
        }),
      );
    }
    if (layout === "symlinked-sibling") {
      // The sibling project is a symlink to a config the name filter alone
      // would not pick up.
      writeFileSync(path.join(root, "plugins-config.json"), siblingProject);
      symlinkSync(
        "plugins-config.json",
        path.join(root, "tsconfig.oxlint-plugins.json"),
      );
    } else {
      writeFileSync(
        path.join(root, "tsconfig.oxlint-plugins.json"),
        siblingProject,
      );
    }
    if (exemptFixture) {
      mkdirSync(path.join(root, path.dirname(exemptFixture)), {
        recursive: true,
      });
      writeFileSync(
        path.join(root, exemptFixture),
        'export const fixture: number = "wrong";',
      );
    }
    const result = Bun.spawnSync(
      [
        process.execPath,
        "scripts/typecheck-coverage.ts",
        "--autofix",
        // A change that touches only an included fixture must still compile.
        ...(includeFixture ? [] : [file, second]),
        ...(exemptFixture ? [exemptFixture] : []),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const output = result.stdout.toString() + result.stderr.toString();
    if (includeFixture) {
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("TS2322");
      expect(output).toContain("bad.fixture.ts");
      expect(output).not.toContain("Autofix types skipped");
      return;
    }
    if (exemptFixture) {
      expect(output).toContain(
        `Autofix types skipped (exempt fixture): ${exemptFixture}`,
      );
    }
    if (layout === "uncovered") {
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("covered by no candidate project");
      expect(output).toContain("tsconfig.json");
      expect(output).toContain("tsconfig.oxlint-plugins.json");
    } else if (invalid) {
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("TS2322");
    } else {
      expect(result.exitCode, output).toBe(0);
      const coveringProjects: Partial<Record<typeof layout, string>> = {
        nearest: "tsconfig.json",
        "nested-sibling": "nested/tsconfig.plugins.json",
      };
      const project =
        coveringProjects[layout] ?? "tsconfig.oxlint-plugins.json";
      expect(output).toContain(`Autofix types checked: ${project} (2 targets)`);
      const checked = readFileSync(
        path.join(root, "compiler-projects"),
        "utf-8",
      )
        .trim()
        .split("\n");
      expect(checked.length).toBe(new Set(checked).size);
      const expectedProjects = ["tsconfig.json"];
      if (layout === "ancestor") {
        expectedProjects.unshift("nested/tsconfig.json");
      }
      if (layout !== "nearest") {
        expectedProjects.push(project);
      }
      // An uncovered fixture is proven uncovered by compiling every
      // candidate once before it is skipped.
      if (exemptFixture) {
        expectedProjects.push("tsconfig.oxlint-plugins.json");
      }
      // The nested sibling is found before any root config is compiled.
      expect(checked).toEqual(
        layout === "nested-sibling" ? [project] : expectedProjects,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// typescript/* safe rules that oxlint runs without type information. Every
// other typescript/* safe rule must name a syntax candidate, so adding a rule
// to the safe list cannot silently skip its type-aware fixes.
const SYNTAX_ONLY_TYPESCRIPT_RULES = {
  "typescript/array-type": "export const values: Array<string> = [];\n",
  "typescript/prefer-as-const": 'export let mode: "a" = "a";\n',
} as const;

const PRECHECK_SNIPPETS = {
  doubleQuoted: 'const o = { a: 1 };\nexport const x = o["a"];\n',
  singleQuoted: "const o = { a: 1 };\nexport const x = o['a'];\n",
  template: "const o = { a: 1 };\nexport const x = o[`a`];\n",
  optional:
    'const o = { a: 1 } as { a?: number } | undefined;\nexport const x = o?.["a"];\n',
  record: 'const r: Record<string, number> = {};\nexport const x = r["key"];\n',
  indexSignature:
    'interface I { [key: string]: number }\ndeclare const i: I;\nexport const x = i["key"];\n',
  privateMember:
    'export class C { private p = 1; read(other: C) { return other["p"]; } }\n',
  keyword: 'const o = { class: 1 };\nexport const x = o["class"];\n',
  dashed: 'const o = { "a-b": 1 };\nexport const x = o["a-b"];\n',
  anyTyped: 'declare const a: any;\nexport const x = a["foo"];\n',
  numericString: 'const o = { 1: 1 };\nexport const x = o["1"];\n',
  jsx: 'const o = { a: "x" };\nexport const view = () => <div title={o["a"]} />;\n',
  dotAccess: "const o = { class: 1, a: 2 };\nexport const x = o.class + o.a;\n",
  variableKey: 'const k = "a";\nconst o = { a: 1 };\nexport const x = o[k];\n',
  numericIndex: "const values = [1];\nexport const x = values[0];\n",
  interpolated:
    'const k = "a";\nconst o: Record<string, number> = { a: 1 };\nexport const x = o[`$' +
    "{k}`];\n",
  arrayLiteral: 'export const keys = ["a", `b`];\n',
  computedKey: 'export const o = { ["a"]: 1 };\n',
  indexedType: 'type T = { a: number };\nexport type A = T["a"];\n',
} as const;

const snippetFileName = (name: string) =>
  `snippet-${name}.${name === "jsx" ? "tsx" : "ts"}`;

test("every type-aware safe rule names a syntax candidate", () => {
  const safeRules = Object.keys(SAFE_AUTOFIX_RULES);
  for (const rule of safeRules.filter((name) =>
    name.startsWith("typescript/"),
  )) {
    expect(
      Object.hasOwn(TYPE_AWARE_SAFE_RULE_CANDIDATES, rule) ||
        Object.hasOwn(SYNTAX_ONLY_TYPESCRIPT_RULES, rule),
      rule,
    ).toBe(true);
  }
  for (const rule of Object.keys(TYPE_AWARE_SAFE_RULE_CANDIDATES)) {
    expect(safeRules).toContain(rule);
  }
  // The dot-notation candidate holds under its default allowKeywords; with
  // `allowKeywords: false` it would also report plain `.class` accesses.
  const repo = path.resolve(import.meta.dirname, "..");
  for (const config of [
    "oxlint.config.ts",
    "node_modules/@stll/oxlint-config/dist/index.mjs",
  ]) {
    expect(readFileSync(path.join(repo, config), "utf-8")).not.toContain(
      "allowKeywords",
    );
  }
});

test("the type-aware pre-check flags only literal-key member access", () => {
  const flagged = Object.entries(PRECHECK_SNIPPETS)
    .filter(([name, source]) =>
      hasTypeAwareCandidate(snippetFileName(name), source),
    )
    .map(([name]) => name)
    .toSorted();
  expect(flagged).toEqual(
    [
      "anyTyped",
      "dashed",
      "doubleQuoted",
      "indexSignature",
      "jsx",
      "keyword",
      "numericString",
      "optional",
      "privateMember",
      "record",
      "singleQuoted",
      "template",
    ].toSorted(),
  );
  // A file the scan cannot parse fails instead of passing unread.
  expect(() => hasTypeAwareCandidate("broken.ts", "const = ;")).toThrow(
    "broken.ts does not parse",
  );
});

test("oxlint reports type-aware safe rules only where the pre-check flags", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autofix-type-aware-precheck-"));
  const repo = path.resolve(import.meta.dirname, "..");
  const lint = (args: readonly string[]) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--bun",
        "oxlint",
        "-c",
        "oxlint.config.ts",
        "--allow",
        "all",
        ...args,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    };
  };
  try {
    symlinkSync(
      path.join(repo, "node_modules"),
      path.join(root, "node_modules"),
    );
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "ESNext",
          jsx: "preserve",
          types: [],
        },
        include: ["*.ts", "*.tsx"],
      }),
    );
    writeFileSync(
      path.join(root, "oxlint.config.ts"),
      'export default { plugins: ["typescript"], categories: { correctness: "off" } };\n',
    );
    for (const [name, source] of Object.entries(PRECHECK_SNIPPETS)) {
      writeFileSync(path.join(root, snippetFileName(name)), source);
    }
    const files = Object.keys(PRECHECK_SNIPPETS).map(snippetFileName);
    for (const rule of Object.keys(TYPE_AWARE_SAFE_RULE_CANDIDATES)) {
      const { exitCode, output } = lint([
        "--type-aware",
        "--deny",
        rule,
        ...files,
      ]);
      expect(exitCode, output).toBe(1);
      const reported = Object.entries(PRECHECK_SNIPPETS).filter(([name]) =>
        output.includes(snippetFileName(name)),
      );
      // Not vacuous: the engine reports the plain case.
      expect(output).toContain(snippetFileName("doubleQuoted"));
      for (const [name, source] of reported) {
        expect(
          hasTypeAwareCandidate(snippetFileName(name), source),
          `${rule} reported ${name}`,
        ).toBe(true);
      }
    }
    // Rules listed as syntax-only report without type information.
    for (const [rule, source] of Object.entries(SYNTAX_ONLY_TYPESCRIPT_RULES)) {
      writeFileSync(path.join(root, "syntax-only.ts"), source);
      const { exitCode, output } = lint(["--deny", rule, "syntax-only.ts"]);
      expect(exitCode, output).toBe(1);
      expect(output).toContain(rule.replace("typescript/", ""));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
