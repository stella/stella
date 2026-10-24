import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUTOFIX_PROTECTED_PATHS,
  isAutofixProtectedPath,
} from "./autofix-protected-paths";
import { BASELINE_PATHS } from "./baseline-paths";

test("every committed baseline and decision ledger is protected", () => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(tracked.exitCode).toBe(0);
  const candidates = tracked.stdout
    .toString()
    .split("\0")
    .filter(
      (file) =>
        /(?:baseline|backlog|ledger|waiver|bailouts)[^/]*\.(?:json|txt)$|[.-]allowlist\.json$/u.test(
          file,
        ) || file.startsWith("scripts/ratchet-allowances/"),
    )
    // Per-job classification decisions are named after their job (a job
    // called `network-baseline-record` is no baseline); the digest generator
    // owns them, and a reclassified job still needs a human review.
    .filter(
      (file) => !file.startsWith(".github/ci-job-classification-decisions/"),
    );
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates.filter((file) => !isAutofixProtectedPath(file))).toEqual(
    [],
  );
  expect(
    Object.values(BASELINE_PATHS).filter(
      (file) => !isAutofixProtectedPath(file),
    ),
  ).toEqual([]);
  expect(
    isAutofixProtectedPath("scripts/ratchet-allowances/new-budget.json"),
  ).toBe(true);
  expect(isAutofixProtectedPath(".changeset/new-release.md")).toBe(true);
});

test("workflow rejects every protected edit despite broad changed-path and generator grants", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autofix-protected-"));
  const workflow = readFileSync(
    new URL("../.github/workflows/autofix.yml", import.meta.url),
    "utf-8",
  );
  const step = workflow.slice(
    workflow.indexOf("      - name: Restrict autofix changes"),
    workflow.indexOf(
      "      - name: Push autofixes",
      workflow.indexOf("      - name: Restrict autofix changes"),
    ),
  );
  const command = step
    .slice(step.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const paths = AUTOFIX_PROTECTED_PATHS.map((pattern) =>
    pattern.replace("**", "example.json"),
  );
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  try {
    git(["init", "-q"]);
    for (const file of paths) {
      write(file, "original\n");
    }
    for (const file of [
      "autofix-baseline-prune.ts",
      "autofix-protected-paths.ts",
      "baseline-paths.ts",
      "baseline-shrink.ts",
      "json-text-edit.ts",
    ]) {
      write(
        `scripts/${file}`,
        readFileSync(new URL(file, import.meta.url), "utf-8"),
      );
    }
    write("changed.ts", "original\n");
    const commit = () => {
      git(["add", "."]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    let head = commit();
    let base = head;
    const run = (file: string) => {
      writeFileSync(path.join(root, "autofix-changed-paths"), `${file}\0`);
      return Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: {
          ...process.env,
          HEAD_SHA: head,
          BASE_SHA: base,
          RUNNER_TEMP: root,
          GENERATOR_ALLOWED: "**",
          TAURI_ALLOWED: "unused",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    };
    for (const file of paths) {
      write(file, "changed\n");
      const result = run(file);
      expect(result.exitCode, `${file}: ${result.stderr.toString()}`).toBe(1);
      expect(result.stdout.toString()).toContain(
        file === "scripts/ratchet-baseline.json"
          ? "Autofix cannot recreate"
          : "Autofix cannot modify",
      );
      write(file, "original\n");
    }
    write("changed.ts", "allowed\n");
    expect(run("changed.ts").exitCode).toBe(0);
    const added = "scripts/ratchet-allowances/new.json";
    write(added, "added\n");
    expect(run(added).exitCode).toBe(1);
    rmSync(path.join(root, added));

    // A shrink-only baseline may lose stale entries, never gain one.
    const baseline = BASELINE_PATHS.sqlPerf;
    write(baseline, '{\n  "a.ts": 1,\n  "b.ts": 2\n}\n');
    write("changed.ts", "original\n");
    head = commit();
    base = head;
    write(baseline, '{\n  "b.ts": 2\n}\n');
    const pruned = run("changed.ts");
    expect(pruned.exitCode, pruned.stderr.toString()).toBe(0);
    for (const loosened of [
      '{\n  "a.ts": 1,\n  "b.ts": 2,\n  "c.ts": 1\n}\n',
      '{\n  "a.ts": 2,\n  "b.ts": 2\n}\n',
    ]) {
      write(baseline, loosened);
      const refused = run("changed.ts");
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout.toString()).toContain("Autofix cannot modify");
    }
    // The pull request cannot loosen the verifier that judges it: the
    // base revision's copy runs, whatever the head carries.
    write(
      "scripts/baseline-shrink.ts",
      "export const shrinkTextViolations = () => [];\nexport const sameEntries = () => false;\n",
    );
    write(baseline, '{\n  "a.ts": 1,\n  "b.ts": 2\n}\n');
    head = commit();
    write(baseline, '{\n  "a.ts": 1,\n  "b.ts": 2,\n  "c.ts": 1\n}\n');
    expect(run("changed.ts").exitCode).toBe(1);
    base = head;

    // A baseline outside the shrink-only registry stays fully protected.
    write(baseline, '{\n  "a.ts": 1,\n  "b.ts": 2\n}\n');
    write(BASELINE_PATHS.bundle, "{}\n");
    head = commit();
    write(BASELINE_PATHS.bundle, "{ }\n");
    expect(run("changed.ts").exitCode).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
