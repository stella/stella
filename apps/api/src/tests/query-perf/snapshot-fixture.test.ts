import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { runSnapshotFixture } from "./snapshot-fixture";

test("exact cache hits restore and read; misses seed and save only after measurement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "query-perf-cache-"));
  try {
    const archive = path.join(directory, "fixture.dump");
    await writeFile(archive, "fixture");
    for (const source of ["fresh", "snapshot"] as const) {
      const calls: string[] = [];
      const reports: Record<string, string | number>[] = [];
      let elapsed = 0;
      const result = await runSnapshotFixture({
        profileId: "small",
        archive,
        source,
        downloadMilliseconds: 5,
        now: () => elapsed,
        seed: async () => {
          calls.push("seed");
          elapsed += 13;
          return "fresh";
        },
        restore: async () => {
          calls.push("restore");
          elapsed += 17;
          return { restoreMs: 7, archiveBytes: 9 };
        },
        read: async () => {
          calls.push("read");
          elapsed += 11;
          return "restored";
        },
        save: async () => {
          calls.push("save");
          return { saveMs: 3, archiveBytes: 9 };
        },
        run: async (seed) => {
          calls.push("measure");
          return seed;
        },
        report: (event) => {
          reports.push(event);
        },
      });
      expect(result).toBe(source === "fresh" ? "fresh" : "restored");
      expect(calls).toEqual(
        source === "fresh"
          ? ["seed", "measure", "save"]
          : ["restore", "read", "measure"],
      );
      if (source === "snapshot") {
        expect(reports).toEqual([
          {
            event: "query_perf_snapshot_restore",
            profileId: "small",
            downloadMilliseconds: 5,
            archiveRestoreMilliseconds: 7,
            restoreMilliseconds: 28,
            totalRestoreMilliseconds: 33,
            archiveBytes: 9,
          },
        ]);
      }
    }
    const calls: string[] = [];
    const options = {
      profileId: "growth" as const,
      archive,
      source: "fresh" as const,
      downloadMilliseconds: 0,
      seed: async () => {
        calls.push("seed");
        return "fresh";
      },
      restore: async () => panic("restore failed"),
      read: async () => {
        calls.push("read");
        return "restored";
      },
      save: async () => {
        calls.push("save");
        return { saveMs: 3, archiveBytes: 9 };
      },
      run: async () => panic("measurement failed"),
      report: () => {},
    };
    expect(await rejectionOf(runSnapshotFixture(options))).toMatchObject({
      message: "measurement failed",
    });
    expect(calls).toEqual(["seed"]);
    calls.length = 0;
    expect(
      await rejectionOf(runSnapshotFixture({ ...options, source: "snapshot" })),
    ).toMatchObject({ message: "restore failed" });
    expect(calls).toEqual([]);
    expect(
      await rejectionOf(
        runSnapshotFixture({
          ...options,
          source: "snapshot",
          archive: path.join(directory, "missing"),
        }),
      ),
    ).toMatchObject({
      message: "Exact query performance cache hit is missing its archive",
    });
    expect(calls).toEqual([]);
    expect(
      await rejectionOf(
        runSnapshotFixture({
          ...options,
          source: "snapshot",
          restore: async () => {
            calls.push("restore");
            return { restoreMs: 7, archiveBytes: 9 };
          },
          read: async () => {
            calls.push("read");
            return panic("restored fixture read failed");
          },
          run: async () => {
            calls.push("measure");
            return "measured";
          },
        }),
      ),
    ).toMatchObject({ message: "restored fixture read failed" });
    expect(calls).toEqual(["restore", "read"]);
    calls.length = 0;
    expect(
      await rejectionOf(
        runSnapshotFixture({
          ...options,
          run: async (seed) => {
            calls.push("measure");
            expect(seed).toBe("fresh");
            return "measured";
          },
          save: async () => {
            calls.push("save");
            return panic("snapshot save failed");
          },
        }),
      ),
    ).toMatchObject({ message: "snapshot save failed" });
    expect(calls).toEqual(["seed", "measure", "save"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
