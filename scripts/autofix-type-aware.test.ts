import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
] as const;

test.each(cases)(
  "type-aware fixes require $name, exclude generated text, and leave unchanged files byte-identical",
  ({ failure, extra }) => {
    const root = mkdtempSync(path.join(tmpdir(), "autofix-type-aware-"));
    const repo = path.resolve(import.meta.dirname, "..");
    const source =
      'export const value = { name: "fixture" };\nexport const name = value["name"];\n';
    try {
      symlinkSync(
        path.join(repo, "node_modules"),
        path.join(root, "node_modules"),
      );
      mkdirSync(path.join(root, "bin"));
      mkdirSync(path.join(root, "scripts"));
      for (const file of [
        "autofix-protected-paths.ts",
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
        "tsgo-compiler-options.ts",
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
        'export default { plugins: ["typescript"], categories: { correctness: "off" }, rules: { "typescript/dot-notation": "error" } };\n',
      );
      writeFileSync(path.join(root, ".oxfmtrc.json"), "{}");
      writeFileSync(path.join(root, "generated.html.txt"), "fixture");
      writeFileSync(
        path.join(root, "autofix-changed-paths"),
        "changed.ts\0generated.html.txt\0",
      );
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
      expect(finding.exitCode).toBe(1);
      expect(finding.stdout.toString() + finding.stderr.toString()).toContain(
        "dot-notation",
      );
      // Generated-source production is covered by its own integration tests;
      // this fixture verifies that the workflow prepares before the real lint fix.
      writeFileSync(
        path.join(root, "bin/bun"),
        `#!/bin/bash
if [[ "$1" == scripts/ci-generated-sources.ts && "$2" == prepare ]]; then touch prepared; exit "$PREPARE_EXIT"; fi
if [[ "$1" == run && "$2" == format:guard ]]; then exit 0; fi
if [[ "$2" == oxlint && ! -f prepared ]]; then exit 2; fi
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
      const step = workflow.slice(
        workflow.indexOf("      - name: Fix changed files"),
        workflow.indexOf("      - name: Restrict autofix changes"),
      );
      const command = step
        .slice(step.indexOf("        run: |\n") + "        run: |\n".length)
        .split("\n")
        .map((line) => line.replace(/^ {10}/u, ""))
        .join("\n");
      const fixed = Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          PREPARE_EXIT: failure === "prepare" ? "1" : "0",
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
      } else {
        expect(fixed.exitCode).not.toBe(0);
        expect(readFileSync(path.join(root, "changed.ts"), "utf-8")).toBe(
          source + extra,
        );
        expect(existsSync(path.join(root, "fixer_ran"))).toBe(false);
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
        failure !== "prepare",
      );
      if (failure !== "prepare") {
        expect(
          readFileSync(path.join(root, "compiler_args"), "utf-8"),
        ).not.toContain("generated.html.txt");
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
  // An invalid lint-rule fixture no project covers rides along with the
  // sources; autofix must skip it, as the coverage check exempts it.
  const exemptFixture = name.startsWith("exempt")
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
    for (const file of [
      "tsc-native.ts",
      "child-exit-status.ts",
      "tsgo-compiler-options.ts",
    ]) {
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
    const config = { compilerOptions, files: [file, second] };
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
        file,
        second,
        ...(exemptFixture ? [exemptFixture] : []),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const output = result.stdout.toString() + result.stderr.toString();
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
      // The nested sibling is found before any root config is compiled.
      expect(checked).toEqual(
        layout === "nested-sibling" ? [project] : expectedProjects,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
