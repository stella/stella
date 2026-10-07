import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("workflow fixes a changed type-aware finding and leaves the unchanged file byte-identical", () => {
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
    for (const file of ["autofix-protected-paths.ts", "baseline-paths.ts"]) {
      writeFileSync(
        path.join(root, "scripts", file),
        readFileSync(new URL(file, import.meta.url)),
      );
    }
    writeFileSync(path.join(root, "changed.ts"), source);
    writeFileSync(path.join(root, "unchanged.ts"), source);
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ESNext", module: "ESNext" },
        include: ["*.ts"],
      }),
    );
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
if [[ "$1" == scripts/ci-generated-sources.ts && "$2" == prepare ]]; then touch prepared; exit 0; fi
if [[ "$1" == run && "$2" == format:guard ]]; then exit 0; fi
if [[ "$2" == oxlint && ! -f prepared ]]; then exit 2; fi
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
        PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(
      fixed.exitCode,
      fixed.stdout.toString() + fixed.stderr.toString(),
    ).toBe(0);
    expect(readFileSync(path.join(root, "changed.ts"), "utf-8")).toBe(
      source.replace('value["name"]', "value.name"),
    );
    expect(readFileSync(path.join(root, "unchanged.ts"), "utf-8")).toBe(source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
