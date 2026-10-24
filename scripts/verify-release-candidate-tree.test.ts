import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const verifier = new URL("verify-release-candidate-tree.mjs", import.meta.url)
  .pathname;

const stderrText = (result: ReturnType<typeof Bun.spawnSync>): string =>
  result.stderr?.toString() ?? "";

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  expect(result.exitCode, stderrText(result)).toBe(0);
  return result.stdout.toString().trim();
};

const writePackage = (
  directory: string,
  version: string,
  extra: Record<string, unknown> = {},
) => {
  writeFileSync(
    path.join(directory, "packages/widget/package.json"),
    `${JSON.stringify(
      { name: "@stll/widget", version, description: "fixture", ...extra },
      null,
      2,
    )}\n`,
  );
};

const writeLock = (directory: string, version: string) => {
  writeFileSync(
    path.join(directory, "bun.lock"),
    `{
  "lockfileVersion": 3,
  "workspaces": {
    "packages/widget": {
      "name": "@stll/widget",
      "version": "${version}",
      "dependencies": {}
    }
  }
}
`,
  );
};

const withCandidate = (
  mutate: (directory: string) => void,
  verify: (result: ReturnType<typeof Bun.spawnSync>) => void,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-tree-"));
  try {
    mkdirSync(path.join(directory, "packages/widget"), { recursive: true });
    mkdirSync(path.join(directory, "docs/changelog"), { recursive: true });
    mkdirSync(path.join(directory, "scripts"), { recursive: true });
    git(directory, "init", "--quiet", "--initial-branch=main", "--template=");
    git(directory, "config", "user.email", "release@example.test");
    git(directory, "config", "user.name", "Release test");
    git(directory, "config", "commit.gpgsign", "false");
    git(directory, "config", "tag.gpgsign", "false");
    writeFileSync(path.join(directory, "VERSION"), "1.2.3\n");
    writePackage(directory, "1.0.0");
    writeLock(directory, "1.0.0");
    git(directory, "add", ".");
    git(directory, "commit", "--quiet", "--message", "main");
    const main = git(directory, "rev-parse", "HEAD");

    git(directory, "checkout", "--quiet", "-b", "release");
    writeFileSync(path.join(directory, "VERSION"), "1.2.4\n");
    mutate(directory);
    git(directory, "add", "-A");
    git(directory, "commit", "--quiet", "--message", "release");
    const candidate = git(directory, "rev-parse", "HEAD");

    verify(
      Bun.spawnSync(["node", verifier, main, candidate], { cwd: directory }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("accepts bounded release data and matching workspace version bumps", () =>
  withCandidate(
    (directory) => {
      writePackage(directory, "1.0.1");
      writeLock(directory, "1.0.1");
      writeFileSync(
        path.join(directory, "docs/changelog/v1.2.4.md"),
        "# 1.2.4\n",
      );
    },
    (result) => expect(result.exitCode, stderrText(result)).toBe(0),
  ));

test.each([
  [
    "an executable path",
    (directory: string) => {
      writeFileSync(path.join(directory, "scripts/publish.sh"), "echo pwn\n");
    },
  ],
  [
    "a package script",
    (directory: string) => {
      writePackage(directory, "1.0.1", {
        scripts: { postinstall: "echo pwn" },
      });
      writeLock(directory, "1.0.1");
    },
  ],
  [
    "an unrelated lock change",
    (directory: string) => {
      writePackage(directory, "1.0.1");
      writeLock(directory, "9.9.9");
    },
  ],
])("rejects %s in a release candidate", (_, mutate) =>
  withCandidate(mutate, (result) => expect(result.exitCode).not.toBe(0)),
);
