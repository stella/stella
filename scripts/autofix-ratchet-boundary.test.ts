import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

type BoundaryCase = { written: string; baseline: string; trusted: boolean };

const runBoundary = ({ written, baseline, trusted }: BoundaryCase) => {
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
if [[ "$1" == merge-base ]]; then echo base; exit 0; fi
if [[ "$1" == diff && "$2" == --quiet && "$3" == HEAD ]]; then exit 1; fi
if [[ "$1" == diff && "$2" == --quiet && "$3" == base ]]; then exit "$TRUST_STATUS"; fi
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(root, "bin/bun"),
      `#!/bin/bash
[[ "$*" == "--no-install --no-env-file scripts/ratchet.ts --check-improvements-only --base base" ]] || exit 1
touch verified
[[ "$(cat scripts/ratchet-baseline.json)" == expected ]]
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(root, "autofix-changed-paths"),
      "scripts/ratchet-baseline.json\0",
    );
    const result = Bun.spawnSync(["bash", "-c", command], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: root,
        HEAD_SHA: "head",
        BASE_SHA: "base",
        RATCHET_WRITTEN: written,
        TRUST_STATUS: trusted ? "0" : "1",
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
  test("changed paths and planner globs cannot replace the generator flag", () => {
    expect(
      runBoundary({ written: "false", baseline: "expected", trusted: true }),
    ).toEqual({ exitCode: 1, verified: false });
  });
  test("the flag permits only an independently verified candidate", () => {
    expect(
      runBoundary({ written: "true", baseline: "expected", trusted: true }),
    ).toEqual({ exitCode: 0, verified: true });
    expect(
      runBoundary({ written: "true", baseline: "tampered", trusted: true }),
    ).toEqual({ exitCode: 1, verified: true });
  });
  test("a forged flag cannot run a modified verifier", () => {
    expect(
      runBoundary({ written: "true", baseline: "expected", trusted: false }),
    ).toEqual({ exitCode: 1, verified: false });
  });
});
