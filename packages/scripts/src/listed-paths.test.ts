import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { listedPaths } from "./listed-paths";

const NODE_SYNC_DEFAULT_MAX_BUFFER = 1024 * 1024;

const runIn = (cwd: string, args: string[], stdin?: string) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};

test("lists a path inventory larger than Node's default sync buffer", () => {
  const root = mkdtempSync(path.join(tmpdir(), "listed-paths-"));
  try {
    runIn(root, ["init", "--quiet"]);
    const blob = runIn(root, ["hash-object", "-w", "--stdin"], "");
    // Index entries only: the listing reads the index, so no file is written.
    const paths = Array.from(
      { length: 5200 },
      (_, index) => `${"d".repeat(200)}/${String(index).padStart(5, "0")}.ts`,
    );
    runIn(
      root,
      ["update-index", "--index-info"],
      paths.map((file) => `100644 ${blob}\t${file}`).join("\n"),
    );
    const listed = listedPaths(root);
    expect(listed).toEqual(paths);
    expect(
      listed.reduce((bytes, file) => bytes + file.length + 1, 0),
    ).toBeGreaterThan(NODE_SYNC_DEFAULT_MAX_BUFFER);
    expect(listedPaths(pathToFileURL(root), ["--", "missing"])).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed listing names the command, directory and git's message", () => {
  const root = mkdtempSync(path.join(tmpdir(), "listed-paths-outside-"));
  try {
    expect(() => listedPaths(root, ["--error-unmatch", "absent.ts"])).toThrow(
      `git ls-files --error-unmatch absent.ts failed in ${root}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
