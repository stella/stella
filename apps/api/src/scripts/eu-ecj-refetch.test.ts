import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  acquireFormexBatch,
  runEuEcjRefetch,
} from "@/api/scripts/eu-ecj-refetch";
import { rootPoolConnectionCount } from "@/api/tests/test-database-environment";

describe("EU refresh command boundaries", () => {
  test("releases the maintenance lane when source lease acquisition rejects", async () => {
    const acquisitionError = new Error("lease database unavailable");
    let releases = 0;
    const acquisition = acquireFormexBatch({
      enterLane: async () => ({
        ingestionDb: "ingestion-db",
        release: async () => {
          releases++;
        },
      }),
      acquireSourceLease: async () => {
        throw acquisitionError;
      },
    });

    expect(await rejectionOf(acquisition)).toBe(acquisitionError);
    expect(releases).toBe(1);
  });

  test("releases the maintenance lane once for a held source lease", async () => {
    let releases = 0;
    const batch = await acquireFormexBatch({
      enterLane: async () => ({
        ingestionDb: "ingestion-db",
        release: async () => {
          releases++;
        },
      }),
      acquireSourceLease: async () => null,
    });

    expect(batch).toBeNull();
    expect(releases).toBe(1);
  });

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

  test("the missing-languages mode runs the backfill with its own flags", async () => {
    const calls: (readonly string[])[] = [];
    const exitCode = await runEuEcjRefetch(
      ["--missing-languages", "--newest", "2026-10", "--oldest", "2023-01"],
      {
        missingLanguages: async (argv) => {
          calls.push(argv);
          return 0;
        },
        formexRefresh: async () => {
          throw new Error("a backfill run must not reach the Formex refresh");
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toEqual([["--newest", "2026-10", "--oldest", "2023-01"]]);
    expect(rootPoolConnectionCount()).toBe(0);
  });

  test("the missing-languages mode refuses an applied run without a journal", async () => {
    expect(await runEuEcjRefetch(["--missing-languages", "--apply"])).toBe(1);
    expect(
      await runEuEcjRefetch(["--missing-languages", "--newest", "2026-13"]),
    ).toBe(1);
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
