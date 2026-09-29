import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationSources,
  schedulerJobs,
} from "@/api/db/schema";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import type { LegislationCorpusDependencies } from "@/api/handlers/legislation/ingestion";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import { logger } from "@/api/lib/observability/logger";
import {
  BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK,
  createLegislationExpressionIdBackfill,
} from "@/api/lib/scheduler/tasks/legislation-expression-id-backfill";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000a01",
);
const UNNAMESPACED_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000a02",
);
const JOB_ID = "test.legislation-expression-id-backfill";
const LEASE = "test-lease";

/** Ids in insertion order, so the keyset walk's order is the fixture's. */
const documentId = (n: number) =>
  toSafeId<"legislationDocument">(
    `0198e331-e578-7000-8000-${n.toString(16).padStart(12, "0")}`,
  );

const iri = (n: number) =>
  `https://example.test/eli/cz/sb/2000/${n}/2020-01-01`;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/** One scheduled run; true when it asked to be followed at once. */
const run = async (
  task: SchedulerTask,
  taskLogger: typeof logger = logger,
): Promise<boolean> => {
  const job = (
    await db.select().from(schedulerJobs).where(eq(schedulerJobs.id, JOB_ID))
  ).at(0);
  if (!job) {
    return panic("expected the scheduler job");
  }
  let continued = false;
  await task({
    db: asTestRaw<SchedulerDb>(db),
    job,
    payload: job.payload,
    runId: createSafeId<"schedulerJobRun">(),
    scheduleContinuation: () => {
      continued = true;
    },
    signal: new AbortController().signal,
    logger: taskLogger,
  });
  return continued;
};

/**
 * Runs until the task stops asking to continue: the rest of the current pass.
 * Bounded, so a task that never stops fails here instead of hanging.
 */
const runPass = async (
  task: SchedulerTask = createLegislationExpressionIdBackfill(),
  taskLogger: typeof logger = logger,
): Promise<number> => {
  for (let runs = 1; runs <= 100; runs += 1) {
    if (!(await run(task, taskLogger))) {
      return runs;
    }
  }
  return panic("the backfill never finished its pass");
};

type LogLine = { message: string; attributes: Record<string, unknown> };

/** A logger that keeps what the task says, for the test to read. */
const recordingLogger = () => {
  const lines: LogLine[] = [];
  const record = (
    message: string,
    attributes: Record<string, unknown> = {},
  ) => {
    lines.push({ message, attributes });
  };
  return {
    lines,
    logger: { ...logger, info: record, warn: record } satisfies typeof logger,
  };
};

const cursor = async (): Promise<unknown> =>
  (
    await db
      .select({ payload: schedulerJobs.payload })
      .from(schedulerJobs)
      .where(eq(schedulerJobs.id, JOB_ID))
  ).at(0)?.payload?.["cursor"];

const idsOf = async (ids: readonly SafeId<"legislationDocument">[]) =>
  (
    await db
      .select({
        id: legislationDocuments.id,
        publisherId: legislationDocuments.publisherExpressionId,
      })
      .from(legislationDocuments)
      .where(inArray(legislationDocuments.id, [...ids]))
      .orderBy(asc(legislationDocuments.id))
  ).map(({ publisherId }) => publisherId);

type LegacyRowOptions = {
  metadata?: Record<string, unknown>;
  sourceId?: SafeId<"legislationSource">;
};

const insertLegacy = async (
  n: number,
  {
    metadata = { versionIri: iri(n) },
    sourceId = SOURCE_ID,
  }: LegacyRowOptions = {},
) => {
  await db.insert(legislationDocuments).values({
    id: documentId(n),
    sourceId,
    eli: `eli/cz/sb/2000/${n}`,
    title: `Act 2000/${n}`,
    country: "CZE",
    language: "cs",
    versionValidFrom: "2020-01-01",
    metadata,
  });
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(legislationSources).values([
    {
      id: SOURCE_ID,
      adapterKey: "expression-backfill-test",
      name: "Expression backfill test",
      expressionNamespace: "esel",
    },
    {
      id: UNNAMESPACED_SOURCE_ID,
      adapterKey: "expression-backfill-unnamespaced",
      name: "Source with no namespace yet",
    },
  ]);
  await db.insert(schedulerJobs).values({
    description: "legislation expression id backfill test",
    id: JOB_ID,
    lockedBy: LEASE,
    nextRunAt: new Date("2026-09-28T00:00:00.000Z"),
    schedule: { type: "interval", everyMs: 60_000 },
    task: BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK,
  });
});

afterAll(async () => {
  await client.close();
});

describe("legislation expression id backfill", () => {
  test("claims in checkpointed pages, resumes from the cursor, and reaches a fixed point", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await insertLegacy(n);
    }
    // Left alone: no IRI to prove an id, and a source with no namespace.
    await insertLegacy(6, { metadata: {} });
    await insertLegacy(7, { sourceId: UNNAMESPACED_SOURCE_ID });
    const ids = [1, 2, 3, 4, 5, 6, 7].map(documentId);

    const twoRowPages = createLegislationExpressionIdBackfill({ pageRows: 2 });

    // A page that leaves rows behind it asks for the next run at once.
    expect(await run(twoRowPages)).toBe(true);
    expect(await cursor()).toBe(documentId(2));
    expect(await idsOf(ids)).toEqual([
      `esel:${iri(1)}`,
      `esel:${iri(2)}`,
      null,
      null,
      null,
      null,
      null,
    ]);

    // The next run resumes after the committed cursor, not from the start.
    await run(twoRowPages);
    expect(await cursor()).toBe(documentId(4));

    // Pages 5-6 and 7, then the end of the table, which asks for nothing more.
    expect(await runPass(twoRowPages)).toBe(3);
    expect(await cursor()).toBeNull();
    const claimed = [
      `esel:${iri(1)}`,
      `esel:${iri(2)}`,
      `esel:${iri(3)}`,
      `esel:${iri(4)}`,
      `esel:${iri(5)}`,
      null,
      null,
    ];
    expect(await idsOf(ids)).toEqual(claimed);

    // A second full pass changes nothing.
    await runPass(twoRowPages);
    expect(await idsOf(ids)).toEqual(claimed);
  });

  test("a row stored after a pass is claimed by the next one, and nothing else about it changes", async () => {
    await insertLegacy(8);
    const unchanged = async () =>
      await db
        .select({
          updatedAt: legislationDocuments.updatedAt,
          payloadRevision: legislationDocuments.payloadRevision,
        })
        .from(legislationDocuments)
        .where(eq(legislationDocuments.id, documentId(8)));
    const before = await unchanged();

    await runPass();

    expect(await idsOf([documentId(8)])).toEqual([`esel:${iri(8)}`]);
    expect(await unchanged()).toEqual(before);
  });

  test("an id another row of the work already carries is not given twice", async () => {
    await insertLegacy(9);
    await db
      .update(legislationDocuments)
      .set({ publisherExpressionId: `esel:${iri(10)}` })
      .where(eq(legislationDocuments.id, documentId(9)));
    await db.insert(legislationDocuments).values({
      id: documentId(10),
      sourceId: SOURCE_ID,
      eli: "eli/cz/sb/2000/9",
      title: "A second row claiming the same version",
      country: "CZE",
      language: "cs",
      versionValidFrom: "2021-01-01",
      metadata: { versionIri: iri(10) },
    });

    await runPass();

    expect(await idsOf([documentId(9), documentId(10)])).toEqual([
      `esel:${iri(10)}`,
      null,
    ]);
  });

  test("an id too long to store, or one two unclaimed rows could take, is left unclaimed and reported", async () => {
    await insertLegacy(12, {
      metadata: { versionIri: `https://example.test/${"x".repeat(1100)}` },
    });
    await insertLegacy(13);
    await db.insert(legislationDocuments).values({
      id: documentId(14),
      sourceId: SOURCE_ID,
      eli: "eli/cz/sb/2000/13",
      title: "A second unclaimed row naming the same version",
      country: "CZE",
      language: "cs",
      versionValidFrom: "2021-01-01",
      metadata: { versionIri: iri(13) },
    });
    await insertLegacy(15);

    // The rows around them are still claimed: nothing poisons the page.
    await runPass();

    expect(await idsOf([12, 13, 14, 15].map(documentId))).toEqual([
      null,
      null,
      null,
      `esel:${iri(15)}`,
    ]);

    // Nothing is left behind silently: each skipped row is named with its
    // reason, and the run's totals count it.
    const { lines, logger: recording } = recordingLogger();
    await runPass(createLegislationExpressionIdBackfill(), recording);
    const skips = lines.filter(
      ({ message }) =>
        message === "scheduler.legislation_expression_ids_skipped",
    );
    const skippedIds = (reason: string) =>
      skips
        .filter(
          ({ attributes }) =>
            attributes["legislationExpressionIds.reason"] === reason,
        )
        .flatMap(({ attributes }) =>
          String(attributes["legislationExpressionIds.documentIds"]).split(","),
        );
    expect(skippedIds("oversized-id")).toEqual([documentId(12)]);
    // Row 10 is the earlier test's: its IRI is already another row's id.
    expect(skippedIds("ambiguous-id").toSorted()).toEqual(
      [documentId(10), documentId(13), documentId(14)].toSorted(),
    );
    // The rows the first test leaves without an IRI or a namespace.
    expect(skippedIds("no-version-iri")).toEqual([documentId(6)]);
    expect(skippedIds("no-namespace")).toEqual([documentId(7)]);
    const summary = lines.find(
      ({ message }) =>
        message === "scheduler.legislation_expression_ids_backfilled",
    );
    expect(summary?.attributes).toMatchObject({
      "legislationExpressionIds.skipped.oversizedId": 1,
      "legislationExpressionIds.skipped.ambiguousId": 3,
      "legislationExpressionIds.skipped.noVersionIri": 1,
      "legislationExpressionIds.skipped.sourceUnprefixed": 1,
    });
  });

  test("the writer finds a row the backfill claimed first, by its id", async () => {
    await insertLegacy(11);
    await runPass();

    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));
    const corpus = {
      mode: "off",
      write: async (input) =>
        await Promise.resolve(
          (() => {
            const plan = planCorpusDocumentWrite(input);
            return plan.type === "put"
              ? { type: "written" as const, written: plan.written }
              : plan;
          })(),
        ),
    } satisfies LegislationCorpusDependencies;
    const result = await processLegislationDocument(
      {
        sourceId: SOURCE_ID,
        eli: "eli/cz/sb/2000/11",
        title: "Act 2000/11",
        country: "CZE",
        language: "cs",
        version: {
          type: "consolidation",
          validFrom: "2020-01-01",
          end: { type: "open" },
        },
        expression: { publisherId: `esel:${iri(11)}` },
        metadata: { versionIri: iri(11) },
        rawHash: "raw-11",
      },
      scopedDb,
      { corpus },
    );

    expect(result).toMatchObject({ type: "stored", id: documentId(11) });
  });
});
