import { expect, test } from "bun:test";
import {
  copyFileSync,
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
  expect(isAutofixProtectedPath("scripts/guard-rollout-policy.ts")).toBe(true);
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
  expect(isAutofixProtectedPath(".changeset/README.md")).toBe(false);
  for (const file of [
    ".changeset/README.md.md",
    ".changeset/readme.md",
    ".changeset/nested/README.md",
  ]) {
    expect(isAutofixProtectedPath(file), file).toBe(true);
  }
});

const protectedPaths = AUTOFIX_PROTECTED_PATHS.map((pattern) =>
  pattern.replace("**", "example.json"),
);
const workflowCases = [
  ...protectedPaths.map((file) => ({ type: "protected" as const, file })),
  { type: "baseline" as const, file: "baseline policy" },
];

test.each(workflowCases)(
  "workflow rejects protected edits: $file",
  (scenario) => {
    const root = mkdtempSync(path.join(tmpdir(), "autofix-protected-"));
    const runnerTemp = mkdtempSync(
      path.join(tmpdir(), "autofix-protected-runner-"),
    );
    const repository = path.resolve(import.meta.dirname, "..");
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
    const paths = protectedPaths;
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
      const workflowTooling = path.join(runnerTemp, "workflow-tooling");
      for (const file of [
        "scripts/generated-conflicts.ts",
        "scripts/autofix-protected-paths.ts",
        "scripts/baseline-paths.ts",
        "scripts/bun-lock-text.ts",
        "scripts/generated-files.ts",
        "packages/scripts/src/generated-files.ts",
      ]) {
        const destination = path.join(workflowTooling, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(repository, file), destination);
      }
      const fixtureLock = '{"packages": {}, "workspaces": {}}\n';
      write("bun.lock", fixtureLock);
      writeFileSync(
        path.join(runnerTemp, "autofix-frozen-bun.lock"),
        fixtureLock,
      );
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
        writeFileSync(
          path.join(runnerTemp, "autofix-changed-paths"),
          `${file}\0`,
        );
        return Bun.spawnSync(["bash", "-c", command], {
          cwd: root,
          env: {
            ...process.env,
            HEAD_SHA: head,
            BASE_SHA: base,
            GITHUB_WORKSPACE: root,
            RUNNER_TEMP: runnerTemp,
            GENERATOR_ALLOWED: "**",
            TAURI_ALLOWED: "unused",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
      };
      if (scenario.type === "protected") {
        const { file } = scenario;
        write(file, "changed\n");
        const result = run(file);
        expect(result.exitCode, `${file}: ${result.stderr.toString()}`).toBe(1);
        expect(result.stdout.toString()).toContain(
          file === "scripts/ratchet-baseline.json"
            ? "Autofix cannot recreate"
            : "Autofix cannot modify",
        );
        return;
      }
      write(".changeset/README.md", "generated documentation\n");
      const readme = run(".changeset/README.md");
      expect(
        readme.exitCode,
        `${readme.stdout.toString()}\n${readme.stderr.toString()}`,
      ).toBe(0);
      rmSync(path.join(root, ".changeset/README.md"));
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
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  },
  20_000,
);
