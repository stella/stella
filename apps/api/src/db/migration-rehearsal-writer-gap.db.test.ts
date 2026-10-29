import { describe, expect, test } from "bun:test";

import { contendSession } from "../../../../scripts/migration-rehearsal-contender";
import {
  judgeWriterGap,
  writerGapReport,
} from "../../../../scripts/migration-rehearsal-writer-gap";
import type { WriterEvent } from "../../../../scripts/migration-rehearsal-writer-gap";
import { withGatedTestClients } from "../tests/gated-test-database";
import {
  CORPUS_SCHEMA_LANE_LOCK_SQL,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
} from "./corpus-schema-lane";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const HOLD_MS = 50;
const LANE_HELD_MS = 1500;
const BUDGET_SECONDS = 1;

describe.skipIf(!enabled)("the rehearsal's writer gap", () => {
  test("a lane held exclusive past the budget starves the writer, and releasing it lets commits resume", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const events: WriterEvent[] = [];
      const commitsSince = (at: number) =>
        events.filter((event) => event.kind === "commit" && event.at >= at)
          .length;
      const untilCommits = async (
        at: number,
        count: number,
        deadline = Date.now() + 10_000,
      ): Promise<void> => {
        if (commitsSince(at) >= count) {
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(`fewer than ${String(count)} commits in 10s`);
        }
        await Bun.sleep(HOLD_MS);
        await untilCommits(at, count, deadline);
      };
      const stop = new AbortController();
      const writer = contendSession({
        connection: openClient().sql,
        updates: ["SELECT 1"],
        holdMs: HOLD_MS,
        onHeld: null,
        onEvent: (kind, at) => {
          events.push({ kind, session: 0, at });
        },
        signal: stop.signal,
      });
      const migrator = await openClient().sql.reserve();
      try {
        const freeFrom = Date.now();
        await untilCommits(freeFrom, 3);
        const free = { startMs: freeFrom, endMs: Date.now() };

        const heldFrom = Date.now();
        await migrator.unsafe(CORPUS_SCHEMA_LANE_LOCK_SQL);
        await Bun.sleep(LANE_HELD_MS);
        await migrator.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
        const releasedAt = Date.now();
        await untilCommits(releasedAt, 3);
        const held = { startMs: heldFrom, endMs: Date.now() };

        const report = (window: { startMs: number; endMs: number }) =>
          writerGapReport({ events, window, sessions: 1 });
        expect(judgeWriterGap(report(free), BUDGET_SECONDS).kind).toBe(
          "within",
        );
        const starved = report(held);
        expect(judgeWriterGap(starved, BUDGET_SECONDS).kind).toBe("over");
        expect(starved.maxGapMs).toBeGreaterThanOrEqual(LANE_HELD_MS - HOLD_MS);
        expect(starved.refusals).toBeGreaterThan(0);
        expect(commitsSince(releasedAt)).toBeGreaterThanOrEqual(3);
      } finally {
        stop.abort();
        await writer;
        await migrator.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
        await migrator.release();
      }
    });
  });
});
