import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const readGitConfig = (key: string) =>
  spawnSync("git", ["config", "--get", key], { encoding: "utf-8" });

test.each([
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["gc.autoDetach", "false"],
])("Git test processes inherit %s=%s", (key, expected) => {
  const result = readGitConfig(key);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe(expected);
});
