import { describe, expect, test } from "bun:test";

import { runEuEcjRefetch } from "@/api/scripts/eu-ecj-refetch";
import { rootPoolConnectionCount } from "@/api/tests/test-database-environment";

describe("EU refresh command boundaries", () => {
  // The image runner forwards this exit code unchanged; that forwarding is
  // covered in apps/legal-atlas-runner's own tests.
  test("returns exit 1 for a resumable publisher refusal", async () => {
    const argv = [
      "--formex-only",
      "--ids-file",
      "ids.txt",
      "--results-out",
      "results.jsonl",
      "--apply",
    ];
    const calls: unknown[] = [];
    for (const resumeAfter of [null, "last-completed-row"]) {
      const exitCode = await runEuEcjRefetch(argv, {
        formexRefresh: async (options) => {
          calls.push(options);
          return {
            type: "rate-limited",
            blockedId: "blocked-row",
            resumeAfter,
            cooldownUntilEpochMs: 123_456,
            results: [],
          };
        },
      });
      expect(exitCode).toBe(1);
    }
    expect(calls).toEqual([
      {
        idsFile: "ids.txt",
        resultsOut: "results.jsonl",
        apply: true,
        limit: null,
        after: null,
      },
      {
        idsFile: "ids.txt",
        resultsOut: "results.jsonl",
        apply: true,
        limit: null,
        after: null,
      },
    ]);
    expect(rootPoolConnectionCount()).toBe(0);
  });

  test("returns exit 0 after a completed Formex refresh", async () => {
    const exitCode = await runEuEcjRefetch(
      ["--formex-only", "--ids-file", "ids.txt"],
      { formexRefresh: async () => ({ type: "complete", results: [] }) },
    );
    expect(exitCode).toBe(0);
    expect(rootPoolConnectionCount()).toBe(0);
  });

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
