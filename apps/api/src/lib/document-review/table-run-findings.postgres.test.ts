/**
 * Verdict batches of one document's table run overlap, because batches at the
 * same dependency level run in parallel. PGlite has a single connection and
 * cannot overlap two transactions, so this suite needs real PostgreSQL.
 *
 * It also holds the review worker to the same batch contract: both executors
 * write each batch through `writeReviewFindingBatch`, so the same findings must
 * show the same progress, complete the run the same way, and inherit the same
 * decisions whichever executor delivered them.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { PlaybookRunProjection } from "@stll/api-contract";
import { waitForExternalState } from "@stll/property-testing/external-state";
import { createTestClock } from "@stll/test-kit";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentReviewFindings,
  documentReviewRuns,
  entities,
  entityVersions,
  fields,
  playbookDefinitions,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockActiveTableRun } from "@/api/lib/db/aggregate-lock";
import {
  buildDocumentReviewFindingRow,
  recountDocumentReviewFindingProgress,
  writeReviewFindingBatch,
} from "@/api/lib/document-review/finding-write";
import { LANGUAGE_DELTA } from "@/api/lib/document-review/review-delta";
import { UNGRADED_VERDICT } from "@/api/lib/document-review/review-grade";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewRunExecutor,
  PinnedPlaybook,
} from "@/api/lib/document-review/run-contract";
import { finalizeWorkerRun } from "@/api/lib/document-review/run-finalize";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import { createPlaybookTableRuns } from "@/api/lib/document-review/table-run-create";
import { recordTableRunVerdicts } from "@/api/lib/document-review/table-run-findings";
import type { RecordTableRunVerdictsArgs } from "@/api/lib/document-review/table-run-findings";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedDocumentReviewRunId } from "@/api/lib/safe-id-boundaries";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { insertOwnerContacts } from "@/api/tests/helpers/owner-contacts";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const clock = createTestClock();

const FIRST_POSITION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_POSITION_ID = "22222222-2222-4222-8222-222222222222";

const gradedPosition = (sourceId: string): Position => ({
  mode: "graded",
  sourceId,
  issue: `Issue ${sourceId}`,
  severity: "high",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [],
        ideal: { source: "inline", text: "Thirty days' written notice." },
      },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: {
    mode: "manual",
    question: "What is the notice period?",
    content: { version: 1, type: "text" },
  },
  enabled: true,
});

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const createFixtureIds = () => ({
  organizationId: mintAuthProviderId<"organization">(),
  userId: mintAuthProviderId<"user">(),
  workspaceId: createSafeId<"workspace">(),
  entityId: createSafeId<"entity">(),
  entityVersionId: createSafeId<"entityVersion">(),
});

type FixtureIds = ReturnType<typeof createFixtureIds>;

/** One matter holding one DOCX document, which is what a table run reviews. */
const seedDocument = async (
  db: GatedTestDb,
  ids: FixtureIds,
): Promise<void> => {
  await db.insert(user).values({
    id: ids.userId,
    name: "Reviewer",
    email: `${ids.userId}@test.local`,
  });
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Org",
    slug: `org-${ids.organizationId}`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const clientId = createSafeId<"contact">();
  await insertOwnerContacts(asTestRaw(db), [
    {
      id: clientId,
      organizationId: ids.organizationId,
      type: "person",
      displayName: "Client",
    },
  ]);
  await db.insert(workspaces).values({
    id: ids.workspaceId,
    organizationId: ids.organizationId,
    clientId,
    name: "Matter",
    reference: `REF-${ids.workspaceId}`,
    status: "active",
  });
  await db.insert(entities).values({
    id: ids.entityId,
    workspaceId: ids.workspaceId,
    kind: "document",
    name: "agreement",
  });
  await db.insert(entityVersions).values({
    id: ids.entityVersionId,
    workspaceId: ids.workspaceId,
    entityId: ids.entityId,
  });
  await db
    .update(entities)
    .set({ currentVersionId: ids.entityVersionId })
    .where(eq(entities.id, ids.entityId));
  const filePropertyId = createSafeId<"property">();
  await db.insert(properties).values({
    id: filePropertyId,
    workspaceId: ids.workspaceId,
    name: "File",
    system: true,
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
    status: "fresh",
  });
  await db.insert(fields).values({
    id: createSafeId<"field">(),
    workspaceId: ids.workspaceId,
    propertyId: filePropertyId,
    entityVersionId: ids.entityVersionId,
    content: {
      version: 1,
      type: "file",
      id: Bun.randomUUIDv7(),
      fileName: "agreement.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: 1024,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: null,
    },
  });
};

type PlaybookFixture = {
  playbook: PinnedPlaybook;
  firstPropertyId: SafeId<"property">;
  secondPropertyId: SafeId<"property">;
};

type RunFixture = PlaybookFixture & {
  runId: SafeId<"documentReviewRun">;
};

/** A playbook of two positions, each answered by its own verdict column. */
const seedTwoPositionPlaybook = async (
  db: GatedTestDb,
  ids: FixtureIds,
): Promise<PlaybookFixture> => {
  const definitionId = createSafeId<"playbookDefinition">();
  const positions = {
    version: 3 as const,
    items: [
      gradedPosition(FIRST_POSITION_ID),
      gradedPosition(SECOND_POSITION_ID),
    ],
  };
  await db.insert(playbookDefinitions).values({
    id: definitionId,
    organizationId: ids.organizationId,
    name: "Termination review",
    positions,
  });

  const firstPropertyId = createSafeId<"property">();
  const secondPropertyId = createSafeId<"property">();
  const column = (id: SafeId<"property">, playbookSourceId: string) => ({
    id,
    workspaceId: ids.workspaceId,
    name: `Column ${playbookSourceId}`,
    status: "stale" as const,
    content: { version: 1 as const, type: "text" as const },
    tool: {
      version: 1 as const,
      type: "ai-model" as const,
      prompt: "What is the notice period?",
    },
    playbookSourceId,
    playbookDefinitionId: definitionId,
  });
  await db
    .insert(properties)
    .values([
      column(firstPropertyId, FIRST_POSITION_ID),
      column(secondPropertyId, SECOND_POSITION_ID),
    ]);

  return {
    playbook: {
      definitionId,
      versionId: null,
      provenance: "draft",
      definitionSnapshot: {
        name: "Termination review",
        positions,
        scope: null,
      },
    },
    firstPropertyId,
    secondPropertyId,
  };
};

/** Opens the document's run: claimed by the table under `columns`, queued for
 *  the review worker under `none`. */
const openRun = async (
  db: GatedTestDb,
  ids: FixtureIds,
  playbook: PlaybookFixture,
  projection: PlaybookRunProjection,
): Promise<RunFixture> => {
  const { runs } = await createPlaybookTableRuns({
    tx: asTestRaw<Transaction>(db),
    workspaceId: ids.workspaceId,
    organizationId: ids.organizationId,
    userId: ids.userId,
    playbook: playbook.playbook,
    docTypeGate: null,
    projection,
  });
  const run = runs.at(0) ?? panic("The fixture document opened no run");
  return { ...playbook, runId: run.runId };
};

/** Opens a table run that plans two positions, each answered by its own column. */
const openTwoPositionRun = async (
  db: GatedTestDb,
  ids: FixtureIds,
): Promise<RunFixture> =>
  await openRun(
    db,
    ids,
    await seedTwoPositionPlaybook(db, ids),
    PLAYBOOK_RUN_PROJECTION.COLUMNS,
  );

const removeFixture = async (
  db: GatedTestDb,
  ids: FixtureIds,
): Promise<void> => {
  await deleteOrganizationsForTest(db, [ids.organizationId]);
  await db.delete(user).where(eq(user.id, ids.userId));
};

type Decided = Pick<
  RecordTableRunVerdictsArgs,
  "graded" | "ungraded" | "unresolvedPropertyIds"
>;

const deviation = (propertyId: SafeId<"property">): Decided => ({
  graded: [
    {
      propertyId,
      verdict: "deviation",
      rationale: "Too short.",
      extracted: null,
    },
  ],
  ungraded: [],
  unresolvedPropertyIds: [],
});

/** The model declined the position's question. */
const refused = (propertyId: SafeId<"property">): Decided => ({
  graded: [],
  ungraded: [{ propertyId, extracted: null }],
  unresolvedPropertyIds: [],
});

type OverlapOptions = {
  databaseUrl: string;
  ids: FixtureIds;
  first: Decided;
  second: Decided;
};

const recordOverlapping = async ({
  databaseUrl: url,
  ids,
  first,
  second,
}: OverlapOptions) =>
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db: firstDb } = openClient({
      connection: { statement_timeout: 10_000 },
    });
    const { db: secondDb } = openClient({
      connection: { statement_timeout: 10_000 },
    });
    const { db: observerDb } = openClient();

    const scopedDbFor = (db: GatedTestDb): ScopedDb =>
      createScopedDb(
        markRlsDatabase(db),
        [ids.workspaceId],
        ids.organizationId,
        ids.userId,
      );
    const record = async (scopedDb: ScopedDb, decided: Decided) =>
      await recordTableRunVerdicts({
        scopedDb,
        organizationId: ids.organizationId,
        workspaceId: ids.workspaceId,
        entityId: ids.entityId,
        entityVersionId: ids.entityVersionId,
        ...decided,
      });

    const firstDidItsWork = Promise.withResolvers<undefined>();
    const commitFirst = Promise.withResolvers<undefined>();
    const firstScopedDb: ScopedDb = async (run) =>
      await scopedDbFor(firstDb)(async (tx) => {
        const result = await run(tx);
        firstDidItsWork.resolve(undefined);
        await commitFirst.promise;
        return result;
      });
    const firstRecorded = record(firstScopedDb, first);
    // A first batch that rejects before signalling must fail the test, not hang it.
    await Promise.race([firstDidItsWork.promise, firstRecorded]);

    let secondPid: number | undefined;
    let secondSettled = false;
    const secondScopedDb: ScopedDb = async (run) =>
      await scopedDbFor(secondDb)(async (tx) => {
        const rows = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        secondPid = rows.at(0)?.pid ?? panic("Missing second backend");
        return await run(tx);
      });
    const secondRecorded = record(secondScopedDb, second).finally(() => {
      secondSettled = true;
    });
    const bothSettled = Promise.allSettled([firstRecorded, secondRecorded]);

    // The second batch either commits while the first is still open, which is
    // the overlap, or waits on the first. Both leave the first one to commit.
    try {
      await waitForExternalState({
        description: "the second batch settles or waits on the first",
        read: async () => {
          if (secondSettled) {
            return true;
          }
          if (secondPid === undefined) {
            return false;
          }
          const rows = await observerDb.execute<{ blockers: number[] }>(
            sql`SELECT pg_blocking_pids(${secondPid}) AS blockers`,
          );
          return (rows.at(0)?.blockers ?? []).length > 0;
        },
      });
    } finally {
      commitFirst.resolve(undefined);
      // The clients close when this callback returns.
      await bothSettled;
    }

    return {
      first: await firstRecorded,
      second: await secondRecorded,
    };
  });

if (!databaseUrl || !runPostgresTests) {
  describe.skip("table run batches on PostgreSQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("table run batches on PostgreSQL", () => {
    const withRun = async (
      fn: (args: {
        db: GatedTestDb;
        ids: FixtureIds;
        fixture: RunFixture;
      }) => Promise<void>,
    ): Promise<void> => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const ids = createFixtureIds();
        try {
          await seedDocument(db, ids);
          await fn({ db, ids, fixture: await openTwoPositionRun(db, ids) });
        } finally {
          await removeFixture(db, ids);
        }
      });
    };

    const readRun = async (
      db: GatedTestDb,
      runId: SafeId<"documentReviewRun">,
    ) => {
      const run =
        (
          await db
            .select({
              status: documentReviewRuns.status,
              completed: documentReviewRuns.completed,
              errorCode: documentReviewRuns.errorCode,
            })
            .from(documentReviewRuns)
            .where(eq(documentReviewRuns.id, runId))
        ).at(0) ?? panic("The fixture run is gone");
      const findings = await db
        .select({ positionId: documentReviewFindings.positionId })
        .from(documentReviewFindings)
        .where(eq(documentReviewFindings.runId, runId));
      return {
        ...run,
        positionIds: findings.map(({ positionId }) => positionId).toSorted(),
      };
    };

    test("the run completes when its last two batches overlap", async () => {
      await withRun(async ({ db, ids, fixture }) => {
        await recordOverlapping({
          databaseUrl,
          ids,
          first: deviation(fixture.firstPropertyId),
          second: deviation(fixture.secondPropertyId),
        });

        expect(await readRun(db, fixture.runId)).toEqual({
          status: "completed",
          completed: 2,
          errorCode: null,
          positionIds: [FIRST_POSITION_ID, SECOND_POSITION_ID],
        });
      });
    });

    test("the run lock leaves the key-share lock a finding insert needs free", async () => {
      await withRun(async ({ db, ids, fixture }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: holderDb } = openClient();
          await holderDb.transaction(async (tx) => {
            await lockActiveTableRun(asTestRaw<Transaction>(tx), {
              workspaceId: ids.workspaceId,
              entityId: ids.entityId,
            });
            const shared = await db
              .select({ id: documentReviewRuns.id })
              .from(documentReviewRuns)
              .where(eq(documentReviewRuns.id, fixture.runId))
              .for("key share", { noWait: true });
            expect(shared).toEqual([{ id: fixture.runId }]);
          });
        });
      });
    });

    test("a batch that overlaps a failing batch writes nothing into the failed run", async () => {
      await withRun(async ({ db, ids, fixture }) => {
        const recorded = await recordOverlapping({
          databaseUrl,
          ids,
          first: {
            graded: [],
            ungraded: [],
            unresolvedPropertyIds: [fixture.firstPropertyId],
          },
          second: deviation(fixture.secondPropertyId),
        });

        expect(recorded.second).toEqual({ type: "no-run" });
        expect(await readRun(db, fixture.runId)).toEqual({
          status: "failed",
          completed: 0,
          errorCode: "playbook_check_failed",
          positionIds: [],
        });
      });
    });

    test("a position the model declined is flagged and the run still completes", async () => {
      await withRun(async ({ db, ids, fixture }) => {
        const scopedDb = createScopedDb(
          markRlsDatabase(db),
          [ids.workspaceId],
          ids.organizationId,
          ids.userId,
        );
        const record = async (decided: Decided) =>
          await recordTableRunVerdicts({
            scopedDb,
            organizationId: ids.organizationId,
            workspaceId: ids.workspaceId,
            entityId: ids.entityId,
            entityVersionId: ids.entityVersionId,
            ...decided,
          });

        expect(await record(refused(fixture.firstPropertyId))).toEqual({
          type: "written",
          findingCount: 1,
          completed: false,
        });
        expect(await readRun(db, fixture.runId)).toEqual({
          status: "running",
          completed: 1,
          errorCode: null,
          positionIds: [FIRST_POSITION_ID],
        });

        expect(await record(deviation(fixture.secondPropertyId))).toEqual({
          type: "written",
          findingCount: 1,
          completed: true,
        });
        expect(await readRun(db, fixture.runId)).toEqual({
          status: "completed",
          completed: 2,
          errorCode: null,
          positionIds: [FIRST_POSITION_ID, SECOND_POSITION_ID],
        });

        const findings = await db
          .select({
            positionId: documentReviewFindings.positionId,
            outcome: documentReviewFindings.outcome,
            payload: documentReviewFindings.payload,
          })
          .from(documentReviewFindings)
          .where(eq(documentReviewFindings.runId, fixture.runId))
          .orderBy(documentReviewFindings.positionId);
        expect(
          findings.map(({ positionId, outcome, payload }) => ({
            positionId,
            outcome,
            rationale: payload.finding.rationale,
          })),
        ).toEqual([
          {
            positionId: FIRST_POSITION_ID,
            outcome: "deviation",
            rationale:
              "Automated comparison against the standard could not be completed.",
          },
          {
            positionId: SECOND_POSITION_ID,
            outcome: "deviation",
            rationale: "Too short.",
          },
        ]);
      });
    });
  });

  describe("both executors' batch paths on PostgreSQL", () => {
    const POSITION_IDS = [FIRST_POSITION_ID, SECOND_POSITION_ID] as const;

    /** A wording deviation, or a question the model declined to answer. */
    type Judgment = "deviation" | "refused";

    type Review = {
      runId: SafeId<"documentReviewRun">;
      /** Delivers one position's finding the way this executor's batch does. */
      deliver: (positionId: string, judgment?: Judgment) => Promise<void>;
      /** What follows the last batch: the worker's post-pass recount and
       *  completion. A table batch completes the run itself. */
      settle: () => Promise<void>;
    };

    const scopedDbFor = (db: GatedTestDb, ids: FixtureIds): ScopedDb =>
      createScopedDb(
        markRlsDatabase(db),
        [ids.workspaceId],
        ids.organizationId,
        ids.userId,
      );

    const startTableReview = async (
      db: GatedTestDb,
      ids: FixtureIds,
      playbook: PlaybookFixture,
    ): Promise<Review> => {
      const run = await openRun(
        db,
        ids,
        playbook,
        PLAYBOOK_RUN_PROJECTION.COLUMNS,
      );
      const propertyIdByPositionId = new Map([
        [FIRST_POSITION_ID, run.firstPropertyId],
        [SECOND_POSITION_ID, run.secondPropertyId],
      ]);
      return {
        runId: run.runId,
        deliver: async (positionId, judgment = "deviation") => {
          const propertyId =
            propertyIdByPositionId.get(positionId) ??
            panic("No column answers this position");
          await recordTableRunVerdicts({
            scopedDb: scopedDbFor(db, ids),
            organizationId: ids.organizationId,
            workspaceId: ids.workspaceId,
            entityId: ids.entityId,
            entityVersionId: ids.entityVersionId,
            ...(judgment === "deviation"
              ? deviation(propertyId)
              : refused(propertyId)),
          });
        },
        settle: async () => {},
      };
    };

    const startWorkerReview = async (
      db: GatedTestDb,
      ids: FixtureIds,
      playbook: PlaybookFixture,
    ): Promise<Review> => {
      const { runId } = await openRun(
        db,
        ids,
        playbook,
        PLAYBOOK_RUN_PROJECTION.NONE,
      );
      // The worker's claim.
      const claimed =
        (
          await db
            .update(documentReviewRuns)
            .set({ status: "running", startedAt: new Date(clock.now()) })
            .where(eq(documentReviewRuns.id, runId))
            .returning({
              basis: documentReviewRuns.basis,
              fileFieldId: documentReviewRuns.fileFieldId,
            })
        ).at(0) ?? panic("The fixture run is gone");
      const plan = planReviewRun({
        basis: claimed.basis,
        executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
      });
      const actor = createRootRunActor(
        {
          organizationId: ids.organizationId,
          userId: ids.userId,
          workspaceId: ids.workspaceId,
          runId,
        },
        brandPersistedDocumentReviewRunId,
        markRlsDatabase(db),
      );
      return {
        runId,
        deliver: async (positionId, judgment = "deviation") => {
          const planned =
            plan.positions.find(
              (candidate) => candidate.positionId === positionId,
            ) ?? panic("The run did not plan this position");
          // The judgment a table batch records for the same verdict: a
          // deviation, or what the worker's grading projects for a question
          // the model declined (flagged, with no answer and no fix).
          const graded =
            judgment === "deviation"
              ? { verdict: "deviation" as const, rationale: "Too short." }
              : {
                  verdict: UNGRADED_VERDICT.verdict,
                  rationale: UNGRADED_VERDICT.rationale,
                };
          const finding: ReviewFinding = {
            positionId,
            issue: planned.position.issue,
            severity: "high",
            standardSource: "tiers",
            ...graded,
            delta: LANGUAGE_DELTA,
            extracted: null,
            citations: [],
            fix: null,
          };
          await actor.writeDb(
            async (tx) =>
              await writeReviewFindingBatch({
                tx,
                workspaceId: ids.workspaceId,
                rows: [
                  buildDocumentReviewFindingRow({
                    organizationId: ids.organizationId,
                    workspaceId: ids.workspaceId,
                    runId,
                    entityId: ids.entityId,
                    fileFieldId: claimed.fileFieldId,
                    entityVersionId: ids.entityVersionId,
                    positionId,
                    positionTitle: planned.title,
                    payload: { finding },
                  }),
                ],
                executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
                runId,
              }),
          );
        },
        settle: async () => {
          await actor.writeDb(
            async (tx) =>
              await recountDocumentReviewFindingProgress({
                tx,
                workspaceId: ids.workspaceId,
                runId,
              }),
          );
          await finalizeWorkerRun({
            actor,
            basis: claimed.basis,
            entityId: ids.entityId,
            fileFieldId: claimed.fileFieldId,
            expectedFindingCount: plan.expectedFindingCount,
          });
        },
      };
    };

    const readProgress = async (
      db: GatedTestDb,
      runId: SafeId<"documentReviewRun">,
    ) =>
      (
        await db
          .select({
            status: documentReviewRuns.status,
            completed: documentReviewRuns.completed,
            errorCode: documentReviewRuns.errorCode,
          })
          .from(documentReviewRuns)
          .where(eq(documentReviewRuns.id, runId))
      ).at(0) ?? panic("The fixture run is gone");

    const readDecisions = async (
      db: GatedTestDb,
      runId: SafeId<"documentReviewRun">,
    ) =>
      await db
        .select({
          positionId: documentReviewFindings.positionId,
          decision: documentReviewFindings.decision,
        })
        .from(documentReviewFindings)
        .where(eq(documentReviewFindings.runId, runId))
        .orderBy(documentReviewFindings.positionId);

    /** Two reviews of one document by one executor: progress after each
     *  batch, the completion, and the decision the second review inherits. */
    const traceReviews = async (
      executor: DocumentReviewRunExecutor,
    ): Promise<unknown> =>
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const ids = createFixtureIds();
        try {
          await seedDocument(db, ids);
          const playbook = await seedTwoPositionPlaybook(db, ids);
          const start =
            executor === DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE
              ? startTableReview
              : startWorkerReview;

          const first = await start(db, ids, playbook);
          await first.deliver(FIRST_POSITION_ID);
          const afterFirstBatch = await readProgress(db, first.runId);
          await first.deliver(SECOND_POSITION_ID);
          await first.settle();
          const afterLastBatch = await readProgress(db, first.runId);

          await db
            .update(documentReviewFindings)
            .set({
              decision: "accepted",
              decidedBy: ids.userId,
              decidedAt: new Date(clock.now()),
            })
            .where(
              and(
                eq(documentReviewFindings.runId, first.runId),
                eq(documentReviewFindings.positionId, FIRST_POSITION_ID),
              ),
            );

          const second = await start(db, ids, playbook);
          for (const positionId of POSITION_IDS) {
            await second.deliver(positionId);
          }
          await second.settle();

          return {
            afterFirstBatch,
            afterLastBatch,
            rereview: {
              ...(await readProgress(db, second.runId)),
              decisions: await readDecisions(db, second.runId),
            },
          };
        } finally {
          await removeFixture(db, ids);
        }
      });

    test("the same findings show the same progress, completion and inherited decisions", async () => {
      const expected = {
        afterFirstBatch: { status: "running", completed: 1, errorCode: null },
        afterLastBatch: { status: "completed", completed: 2, errorCode: null },
        rereview: {
          status: "completed",
          completed: 2,
          errorCode: null,
          decisions: [
            { positionId: FIRST_POSITION_ID, decision: "accepted" },
            { positionId: SECOND_POSITION_ID, decision: "open" },
          ],
        },
      };

      expect({
        worker: await traceReviews(DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER),
        table: await traceReviews(DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE),
      }).toEqual({ worker: expected, table: expected });
    });

    /** One review where the model declined the first position's question. */
    const traceDeclinedReview = async (
      executor: DocumentReviewRunExecutor,
    ): Promise<unknown> =>
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const ids = createFixtureIds();
        try {
          await seedDocument(db, ids);
          const playbook = await seedTwoPositionPlaybook(db, ids);
          const review = await (
            executor === DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE
              ? startTableReview
              : startWorkerReview
          )(db, ids, playbook);

          await review.deliver(FIRST_POSITION_ID, "refused");
          const afterDeclinedBatch = await readProgress(db, review.runId);
          await review.deliver(SECOND_POSITION_ID);
          await review.settle();

          const findings = await db
            .select({
              positionId: documentReviewFindings.positionId,
              outcome: documentReviewFindings.outcome,
              payload: documentReviewFindings.payload,
            })
            .from(documentReviewFindings)
            .where(eq(documentReviewFindings.runId, review.runId))
            .orderBy(documentReviewFindings.positionId);
          return {
            afterDeclinedBatch,
            afterLastBatch: await readProgress(db, review.runId),
            findings,
          };
        } finally {
          await removeFixture(db, ids);
        }
      });

    test("a declined position is flagged the same way and the run completes", async () => {
      const worker = await traceDeclinedReview(
        DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
      );
      const table = await traceDeclinedReview(
        DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
      );

      expect(table).toEqual(worker);
      expect(worker).toMatchObject({
        afterDeclinedBatch: {
          status: "running",
          completed: 1,
          errorCode: null,
        },
        afterLastBatch: { status: "completed", completed: 2, errorCode: null },
        findings: [
          {
            positionId: FIRST_POSITION_ID,
            outcome: "deviation",
            payload: {
              finding: {
                verdict: "deviation",
                rationale:
                  "Automated comparison against the standard could not be completed.",
                extracted: null,
                fix: null,
              },
            },
          },
          { positionId: SECOND_POSITION_ID, outcome: "deviation" },
        ],
      });
    });
  });
}
