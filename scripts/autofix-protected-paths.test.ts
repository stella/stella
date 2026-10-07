import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
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
  expect(isAutofixProtectedPath("apps/api/scripts/test-durations.json")).toBe(
    false,
  );
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
    for (const file of ["autofix-protected-paths.ts", "baseline-paths.ts"]) {
      write(
        `scripts/${file}`,
        readFileSync(new URL(file, import.meta.url), "utf-8"),
      );
    }
    write("changed.ts", "original\n");
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
    const head = git(["rev-parse", "HEAD"]);
    const run = (file: string) => {
      writeFileSync(path.join(root, "autofix-changed-paths"), `${file}\0`);
      return Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: {
          ...process.env,
          HEAD_SHA: head,
          RUNNER_TEMP: root,
          GENERATOR_ALLOWED: "**",
          TAURI_ALLOWED: "unused",
          WEIGHTS_ALLOWED: "",
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
