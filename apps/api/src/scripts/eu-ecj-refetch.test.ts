import { describe, expect, test } from "bun:test";

import { runEuEcjRefetch } from "@/api/scripts/eu-ecj-refetch";
import { rootPoolConnectionCount } from "@/api/tests/test-database-environment";

describe("EU refresh command boundaries", () => {
  test("rejects Formex-only flags in a full refetch", async () => {
    for (const flag of ["--ids-file", "--results-out"]) {
      expect(
        await runEuEcjRefetch(["--celex", "62022CJ0123", flag, "file.txt"]),
      ).toBe(1);
    }
    expect(rootPoolConnectionCount()).toBe(0);
  });
  test("rejects invalid pacing before opening a database session", async () => {
    for (const rate of ["0", "-1", "2.1", "Infinity", "invalid"]) {
      expect(await runEuEcjRefetch(["--requests-per-second", rate])).toBe(1);
    }
    expect(rootPoolConnectionCount()).toBe(0);
  });

  test("requires a journal for applied Formex refreshes", async () => {
    expect(
      await runEuEcjRefetch([
        "--formex-only",
        "--apply",
        "--ids-file",
        "ids.txt",
      ]),
    ).toBe(1);
    expect(rootPoolConnectionCount()).toBe(0);
  });

  test("rejects missing and competing Formex inputs before database access", async () => {
    expect(await runEuEcjRefetch(["--formex-only"])).toBe(1);
    expect(
      await runEuEcjRefetch([
        "--formex-only",
        "--ids-file",
        "ids.txt",
        "--celex",
        "62022CJ0123",
      ]),
    ).toBe(1);
    expect(rootPoolConnectionCount()).toBe(0);
  });
});
