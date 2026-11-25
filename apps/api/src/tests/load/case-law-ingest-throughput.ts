import { Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseArgs } from "node:util";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";
import {
  type GatedTestClientScope,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { courtListenerIngestFixture } from "@/api/tests/helpers/case-law-ingest-fixture";
import {
  applyIngestStream,
  cloneCaseLawSchema,
  dropCaseLawSchema,
  insertCourtListenerSource,
  useCaseLawSchema,
} from "@/api/tests/helpers/case-law-ingest-schema";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

/**
 * Throughput of the case-law batch writer on a real PostgreSQL, and where a
 * decision's time goes: the citation graph lock (waiting for it, holding
 * it), the other transactions of a decision, the corpus settlement, and
 * object storage (an in-process store answering after `--s3-ms`).
 *
 * Each run applies the CourtListener fixture stream into its own copy of the
 * case-law tables, in batches of 200 as a crawl does, and drops the copy.
 *
 * Usage (against the gated test database):
 *   NODE_ENV=test STELLA_LOCAL_DEV=1 bun run apps/api/src/tests/load/case-law-ingest-throughput.ts \
 *     --count 1000 --concurrency 1,16 --s3-ms 0 --pool 5
 */

const { values: options } = parseArgs({
  options: {
    count: { type: "string", default: "1000" },
    concurrency: { type: "string", default: "1,16" },
    "s3-ms": { type: "string", default: "0" },
    pool: { type: "string", default: "5" },
  },
});
const count = Number(options.count);
const s3DelayMs = Number(options["s3-ms"]);
const pool = Number(options.pool);
const concurrencies = options.concurrency.split(",").map(Number);

type TransactionTrace = {
  phase: "decision" | "settlement";
  start: number;
  end: number;
  graphRequestedAt: number | null;
  graphHeldAt: number | null;
};

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);
const round = (value: number, places = 2) =>
  Math.round(value * 10 ** places) / 10 ** places;

const measure = async (concurrency: number) => {
  const traces: TransactionTrace[] = [];
  const context = new AsyncLocalStorage<TransactionTrace>();
  let phase: TransactionTrace["phase"] = "decision";
  const run = async ({ openClient }: GatedTestClientScope) => {
    const { db } = openClient({
      max: pool,
      logger: {
        logQuery: (query) => {
          const trace = context.getStore();
          if (trace === undefined) {
            return;
          }
          const now = performance.now();
          // A transaction's statements run one after another: the first one
          // logged after the lock request is issued once the lock is held.
          if (trace.graphRequestedAt !== null && trace.graphHeldAt === null) {
            trace.graphHeldAt = now;
          }
          if (query.includes("'citation_resolution_walk'")) {
            trace.graphRequestedAt = now;
          }
        },
      },
    });
    const schemaName = `ingest_measure_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await cloneCaseLawSchema(db, schemaName);
    const scopedDb: ScopedDb = async (callback) => {
      const trace: TransactionTrace = {
        phase,
        start: performance.now(),
        end: 0,
        graphRequestedAt: null,
        graphHeldAt: null,
      };
      traces.push(trace);
      try {
        return await context.run(
          trace,
          async () =>
            await db.transaction(async (tx) => {
              await useCaseLawSchema(tx, schemaName);
              return await callback(tx);
            }),
        );
      } finally {
        trace.end = performance.now();
      }
    };
    const fakeS3 = startFakeS3({ delayMs: s3DelayMs });
    try {
      const sourceId = createSafeId<"caseLawSource">();
      await insertCourtListenerSource(scopedDb, sourceId);
      traces.length = 0;
      const decisions = courtListenerIngestFixture({ count, namespace: 7001 });
      const started = performance.now();
      const applied = await applyIngestStream({
        scopedDb,
        sourceId,
        decisions,
        concurrency,
        corpus: {
          mode: "canonical",
          transfer: {
            layout: "packs",
            putPacks: async () => {
              if (s3DelayMs > 0) {
                await Bun.sleep(s3DelayMs);
              }
              phase = "settlement";
              return Result.ok(undefined);
            },
          },
        },
        beforeBatch: () => {
          phase = "decision";
        },
      });
      const wall = performance.now() - started;
      const graph = traces.filter((trace) => trace.graphRequestedAt !== null);
      const graphWait = sum(
        graph.map(
          (trace) =>
            (trace.graphHeldAt ?? trace.end) -
            (trace.graphRequestedAt ?? trace.start),
        ),
      );
      const graphHold = sum(
        graph.map((trace) => trace.end - (trace.graphHeldAt ?? trace.end)),
      );
      const other = traces.filter(
        (trace) =>
          trace.graphRequestedAt === null && trace.phase === "decision",
      );
      const settlement = traces.filter(
        (trace) =>
          trace.graphRequestedAt === null && trace.phase === "settlement",
      );
      const elapsed = (list: readonly TransactionTrace[]) =>
        sum(list.map((trace) => trace.end - trace.start));
      const s3Requests = fakeS3.requests.length;
      const holds = graph
        .map((trace) => trace.end - (trace.graphHeldAt ?? trace.end))
        .toSorted((left, right) => left - right);
      return {
        concurrency,
        pool,
        decisions: count,
        inserted: sum(applied.map(({ inserted }) => inserted)),
        halts: applied.flatMap(({ halt }) =>
          halt === null ? [] : [halt.type],
        ),
        s3DelayMs,
        wallSeconds: round(wall / 1000),
        decisionsPerSecond: round((count / wall) * 1000, 1),
        perDecisionMs: {
          wall: round(wall / count),
          graphLockWait: round(graphWait / count),
          graphLockHold: round(graphHold / count),
          otherTransactions: round(elapsed(other) / count),
          settlement: round(elapsed(settlement) / count),
          objectStorage: round((s3Requests * s3DelayMs) / count),
        },
        perDecisionCount: {
          graphTransactions: round(graph.length / count),
          otherTransactions: round(other.length / count),
          settlementTransactions: round(settlement.length / count),
          objectStorageRequests: round(s3Requests / count),
        },
        graphLockHoldP50Ms: round(holds.at(Math.floor(holds.length / 2)) ?? 0),
        graphLockHoldP95Ms: round(
          holds.at(Math.floor(holds.length * 0.95)) ?? 0,
        ),
        graphLockUtilisation: round(graphHold / wall, 3),
      };
    } finally {
      fakeS3.stop();
      await dropCaseLawSchema(db, schemaName);
    }
  };
  return await withGatedTestClients(databaseUrl, run);
};

const report = [];
for (const concurrency of concurrencies) {
  report.push(await measure(concurrency));
}
console.log(JSON.stringify(report, null, 2));
