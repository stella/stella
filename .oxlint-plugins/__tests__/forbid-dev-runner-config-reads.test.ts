import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects direct and destructured runner CLI and configuration inputs", async () => {
  expect(
    await lintSingleRule(
      "forbid-dev-runner-config-reads",
      [
        "const args = process.argv;",
        'const computedArgs = process["argv"];',
        "const instance = process.env.STELLA_DEV_INSTANCE;",
        'const infrastructure = process.env["STELLA_INFRA_OFFSET"];',
        "const port = process.env.STELLA_PORT_OFFSET;",
        "const { argv: parsedArgs } = process;",
        "const { STELLA_PORT_OFFSET: parsedPort } = process.env;",
        "const { STELLA_DEV_INSTANCE, STELLA_INFRA_OFFSET } = process.env;",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("allows environment forwarding and unrelated environment or object reads", async () => {
  expect(
    await lintSingleRule(
      "forbid-dev-runner-config-reads",
      [
        "const child = Bun.spawn(command, { env: process.env });",
        "const environment = process.env.NODE_ENV;",
        "const { NODE_ENV } = process.env;",
        "const local = { argv: [] };",
        "const argumentsList = local.argv;",
        "const config = readDevRunnerConfig();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
