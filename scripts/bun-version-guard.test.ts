import { afterEach, expect, test } from "bun:test";
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

import { repoRelativePath } from "../packages/portable-path/src/index";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const guardPath = path.join(import.meta.dir, "bun-version-guard.ts");
const packageJson = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf-8"),
);
const pinnedVersion = packageJson.packageManager.replace(/^bun@/u, "");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const trackedBunfigs = () => {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "*bunfig.toml"], {
    cwd: repositoryRoot,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\0").filter(Boolean);
};

test("every tracked bunfig.toml registers the version guard as a runtime preload", () => {
  const bunfigs = trackedBunfigs();
  expect(bunfigs.length).toBeGreaterThan(0);

  for (const bunfig of bunfigs) {
    const contents = readFileSync(path.join(repositoryRoot, bunfig), "utf-8");
    const relativeGuard = repoRelativePath(
      path.dirname(bunfig),
      "scripts/bun-version-guard.ts",
    );
    const configuredPath = relativeGuard.startsWith(".")
      ? relativeGuard
      : `./${relativeGuard}`;
    expect(contents).toMatch(
      new RegExp(
        `^preload = \\["${configuredPath.replaceAll(".", "\\.")}"\\]$`,
        "mu",
      ),
    );
    expect(contents.indexOf("preload =")).toBeLessThan(
      contents.indexOf("[install]"),
    );
  }
});

test("the guard imports only Node built-ins", () => {
  const source = readFileSync(guardPath, "utf-8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(
    (match) => match[1],
  );
  expect(imports).toEqual(["node:fs", "node:path"]);
});

const runGuardWithVersion = (version: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "bun-version-guard-"));
  roots.push(root);
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(
    path.join(repositoryRoot, "package.json"),
    path.join(root, "package.json"),
  );
  const source = readFileSync(guardPath, "utf-8").replace(
    /Bun\.version/gu,
    () => JSON.stringify(version),
  );
  writeFileSync(path.join(root, "scripts/bun-version-guard.ts"), source);
  return Bun.spawnSync([process.execPath, "scripts/bun-version-guard.ts"], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
};

test("accepts the pinned Bun version", () => {
  const result = runGuardWithVersion(pinnedVersion);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
});

test("rejects a mismatching Bun version with the exact diagnostic", () => {
  const runningVersion = "0.0.0-test-mismatch";
  const result = runGuardWithVersion(runningVersion);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe(
    `BunVersionMismatch: this checkout pins Bun ${pinnedVersion}; ${process.execPath} is Bun ${runningVersion}. Put the pinned Bun first on PATH (or remove the other one).\n`,
  );
});
