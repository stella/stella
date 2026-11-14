import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "typecheck-command-probe.sh");
const originalSource = "export const original: number = 1;\n";

const runProbe = (selection: "existing" | "unique") => {
  const directory = mkdtempSync(path.join(tmpdir(), "typecheck-probe-"));
  const sourceDirectory = path.join(directory, "packages/sha256/src");
  const bin = path.join(directory, "bin");
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(bin);
  const original = path.join(sourceDirectory, "typecheck-command-probe.ts");
  writeFileSync(original, originalSource);
  const candidate = path.join(
    sourceDirectory,
    "typecheck-command-probe.candidate.ts",
  );
  if (selection === "existing") {
    writeFileSync(candidate, originalSource);
    writeFileSync(
      path.join(bin, "mktemp"),
      `#!/usr/bin/env bash
printf 'packages/sha256/src/typecheck-command-probe.candidate\\n'
`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    path.join(bin, "bun"),
    `#!/usr/bin/env bash
printf 'called\\n' >> calls.log
for probe in packages/sha256/src/typecheck-command-probe.*.ts; do
  if [[ -f "$probe" ]]; then
    printf '%s: error TS2322: seeded type error\\n' "\${probe##*/}"
    exit 1
  fi
done
`,
    { mode: 0o755 },
  );
  try {
    const result = Bun.spawnSync(["bash", script], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: directory,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      files: readdirSync(sourceDirectory).toSorted(),
      original: existsSync(original)
        ? readFileSync(original, "utf-8")
        : undefined,
      candidate: existsSync(candidate)
        ? readFileSync(candidate, "utf-8")
        : undefined,
      calls: existsSync(path.join(directory, "calls.log"))
        ? readFileSync(path.join(directory, "calls.log"), "utf-8")
        : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("an existing selected probe path is preserved and fails before checking", () => {
  const result = runProbe("existing");
  expect(result.exitCode).not.toBe(0);
  expect(result.original).toBe(originalSource);
  expect(result.candidate).toBe(originalSource);
  expect(result.calls).toBe("");
  expect(result.files).toEqual([
    "typecheck-command-probe.candidate.ts",
    "typecheck-command-probe.ts",
  ]);
});

test("a unique probe is checked and cleaned up while branch files survive", () => {
  const result = runProbe("unique");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.original).toBe(originalSource);
  expect(result.calls).toBe("called\ncalled\n");
  expect(result.files).toEqual(["typecheck-command-probe.ts"]);
});
