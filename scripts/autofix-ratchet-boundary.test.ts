import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AUTOFIX_PROTECTED_PATHS } from "./autofix-protected-paths";
import { parseVerifyWorkflow } from "./verify-workflow";

const workflow = await Bun.file(
  new URL("../.github/workflows/autofix.yml", import.meta.url),
).text();
const job = workflow.slice(workflow.indexOf("  regenerate-derived-files:"));
const restriction = job.slice(
  job.indexOf("      - name: Restrict autofix changes"),
  job.indexOf("      - name: Push autofixes"),
);
const command = restriction
  .slice(restriction.indexOf("        run: |\n") + "        run: |\n".length)
  .split("\n")
  .map((line) => line.replace(/^ {10}/u, ""))
  .join("\n");

type BoundaryCase = { written: string; baseline: string };

const runBoundary = ({ written, baseline }: BoundaryCase) => {
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-autofix-boundary-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "scripts/ratchet-baseline.json"), baseline);
    // These stand-ins isolate the workflow's authorization logic from scans.
    writeFileSync(
      path.join(root, "bin/git"),
      `#!/bin/bash
if [[ "$1" == rev-parse ]]; then echo head; exit 0; fi
if [[ "$1" == diff && "$2" == --quiet && "$3" == HEAD ]]; then exit 1; fi
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(root, "bin/bun"),
      `#!/bin/bash
touch verified
exit 1
`,
      { mode: 0o755 },
    );
    // The fixer steps read the push scope; a run without a settled
    // commit scopes every changed path.
    for (const name of ["autofix-changed-paths", "autofix-fix-paths"]) {
      writeFileSync(path.join(root, name), "scripts/ratchet-baseline.json\0");
    }
    const result = Bun.spawnSync(["bash", "-c", command], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: root,
        HEAD_SHA: "head",
        BASE_SHA: "base",
        RATCHET_WRITTEN: written,
        // Even a broad planner output must not authorize the protected path.
        GENERATOR_ALLOWED: "scripts/**|scripts/ratchet-baseline.json",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      verified: existsSync(path.join(root, "verified")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("ratchet autofix output boundary", () => {
  test("the actual fixer excludes each protected glob with the installed Bash", () => {
    const step = parseVerifyWorkflow(workflow, "autofix").find(
      ({ name }) => name === "Fix changed files",
    );
    if (!step) {
      panic("Autofix changed-file owner is missing");
    }
    const root = mkdtempSync(path.join(tmpdir(), "autofix-glob-boundary-"));
    try {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      const protectedPaths = AUTOFIX_PROTECTED_PATHS.map((pattern) => {
        expect(pattern).not.toMatch(/[|(){}@]/u);
        return pattern.replace(/\*+/gu, "fixture.json");
      });
      const unprotected = "scripts/unprotected.json";
      for (const file of [...protectedPaths, unprotected]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "{}");
      }
      writeFileSync(
        path.join(root, "policy"),
        `${AUTOFIX_PROTECTED_PATHS.join("\n")}\n`,
      );
      // The fixer steps read the push scope; a run without a settled
      // commit scopes every changed path.
      for (const name of ["autofix-changed-paths", "autofix-fix-paths"]) {
        writeFileSync(
          path.join(root, name),
          `${[...protectedPaths, unprotected].join("\0")}\0`,
        );
      }
      writeFileSync(
        path.join(bin, "bun"),
        `#!/bin/bash
if [[ "$1" == scripts/autofix-protected-paths.ts ]]; then cat "$RUNNER_TEMP/policy"; exit 0; fi
printf '%s\\n' "$@" >> "$RUNNER_TEMP/commands"
`,
        { mode: 0o755 },
      );
      const result = Bun.spawnSync(["bash", "-c", step.run], {
        cwd: root,
        env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const commands = readFileSync(path.join(root, "commands"), "utf-8");
      expect(commands).toContain(`./${unprotected}`);
      for (const file of protectedPaths) {
        expect(commands).not.toContain(`./${file}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("changed paths and planner globs cannot authorize a retired budget", () => {
    expect(runBoundary({ written: "false", baseline: "expected" })).toEqual({
      exitCode: 1,
      verified: false,
    });
  });
  test("autofix refuses a retired baseline even with a forged generator flag", () => {
    for (const baseline of ["expected", "tampered"]) {
      expect(runBoundary({ written: "true", baseline })).toEqual({
        exitCode: 1,
        verified: false,
      });
    }
  });
});
