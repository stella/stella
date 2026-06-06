import { describe, expect, test } from "bun:test";

import { runCli } from "./index";

describe("legal-atlas CLI", () => {
  test("smoke command validates runner registration", async () => {
    const exitCode = await runCli(["smoke"]);

    expect(exitCode).toBe(0);
  });

  test("reserved runners fail closed instead of silently no-oping", async () => {
    const exitCode = await runCli(["run", "case-law-ingest"]);

    expect(exitCode).toBe(78);
  });
});
