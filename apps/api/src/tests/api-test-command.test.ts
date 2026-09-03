import { describe, expect, test } from "bun:test";

import { buildApiTestCommand } from "../../scripts/api-test-command";
import { API_TEST_TIMEOUT_MS } from "./test-timeouts";

const TIMEOUT_ARGUMENT = `--timeout=${API_TEST_TIMEOUT_MS}`;

describe("API test child commands", () => {
  for (const { name, runtimeArguments, testArguments } of [
    {
      name: "shared-process batches",
      runtimeArguments: ["--smol"],
      testArguments: ["--preload", "/api/setup-env.ts", "--bail"],
    },
    {
      name: "isolated batches",
      runtimeArguments: ["--smol"],
      testArguments: ["--preload", "/api/setup-env.ts", "--isolate"],
    },
    {
      name: "Postgres-gated tests",
      runtimeArguments: [],
      testArguments: [
        "--max-concurrency=1",
        "--preload",
        "./src/tests/setup-env.ts",
      ],
    },
  ]) {
    test(`${name} receive the shared timeout`, () => {
      const command = buildApiTestCommand({
        bunExecutable: "/usr/bin/bun",
        bunRuntimeArguments: runtimeArguments,
        testArguments,
        testFiles: ["src/example.test.ts"],
      });

      expect(command).toContain(TIMEOUT_ARGUMENT);
      expect(command.indexOf(TIMEOUT_ARGUMENT)).toBeLessThan(
        command.indexOf("src/example.test.ts"),
      );
    });
  }
});
