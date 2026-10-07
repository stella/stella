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
  "type-aware fixes require $name and leave unchanged files byte-identical",
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
      writeFileSync(path.join(root, "autofix-changed-paths"), "changed.ts\0");
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
if [[ "$1" == scripts/typecheck-coverage.ts && "$2" == --autofix ]]; then touch compiler_checked; fi
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
            "excluded from the checked project",
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
      expect(readFileSync(path.join(root, "unchanged.ts"), "utf-8")).toBe(
        source,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
