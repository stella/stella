import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("every development Docker executable reference requires the pinned owner", async () => {
  const source = [
    'Bun.spawnSync(["docker", "ps"]);',
    'resolveCommandPath("docker");',
    'Bun.spawn(["/usr/local/bin/docker", "compose", "down"]);',
    'const executable = "C:\\\\tools\\\\docker.exe";',
    'Bun.spawn([`docker`, "ps"]);',
    'dockerCommand(target, ["ps"]);',
  ].join("\n");
  expect(
    await lintSingleRule("no-ambient-dev-docker", source, {
      sourcePath: "packages/scripts/src/dev-new-helper.ts",
    }),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("endpoint discovery and pinned construction remain at their owner", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-dev-docker",
      'const command = ["docker", "--host", target.host, "ps"];',
      {
        sourcePath: "packages/scripts/src/dev-docker.ts",
      },
    ),
  ).toEqual([]);
});

test("test fixtures and other tools can model Docker commands", async () => {
  for (const sourcePath of [
    "packages/scripts/src/dev-docker.test.ts",
    "scripts/ci-images.ts",
  ]) {
    expect(
      await lintSingleRule(
        "no-ambient-dev-docker",
        'const command = ["docker", "version"];',
        { sourcePath },
      ),
    ).toEqual([]);
  }
});
