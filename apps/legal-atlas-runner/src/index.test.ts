import { describe, expect, test } from "bun:test";

import { runCli } from "./index";

describe("legal-atlas CLI", () => {
  test("dispatches the EU refresh command and forwards operator arguments", async () => {
    const args = [
      "--formex-only",
      "--ids-file",
      "ids.txt",
      "--results-out",
      "results.jsonl",
      "--apply",
    ];
    const calls: (readonly string[])[] = [];
    const exitCode = await runCli(["run", "eu-ecj-refetch", ...args], {
      refetch: async (argv) => {
        calls.push(argv);
        return 23;
      },
    });
    expect(calls).toEqual([args]);
    expect(exitCode).toBe(23);
  });
  test("smoke command validates runner registration", async () => {
    const exitCode = await runCli(["smoke"]);

    expect(exitCode).toBe(0);
  });

  test("reserved runners fail closed instead of silently no-oping", async () => {
    const exitCode = await runCli(["run", "statute-ingest"]);

    expect(exitCode).toBe(78);
  });
});
