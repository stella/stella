/**
 * Verdict batches of one document's table run overlap, because batches at the
 * same dependency level run in parallel. PGlite has a single connection and
 * cannot overlap two transactions, so this suite needs real PostgreSQL.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { waitForExternalState } from "@stll/property-testing/external-state";

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
import { createPlaybookTableRuns } from "@/api/lib/document-review/table-run-create";
import { recordTableRunVerdicts } from "@/api/lib/document-review/table-run-findings";
import type { RecordTableRunVerdictsArgs } from "@/api/lib/document-review/table-run-findings";
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

type RunFixture = {
  runId: SafeId<"documentReviewRun">;
  firstPropertyId: SafeId<"property">;
  secondPropertyId: SafeId<"property">;
};

/** Opens a table run that plans two positions, each answered by its own column. */
const openTwoPositionRun = async (
  db: GatedTestDb,
  ids: FixtureIds,
): Promise<RunFixture> => {
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

  const { runs } = await createPlaybookTableRuns({
    tx: asTestRaw<Transaction>(db),
    workspaceId: ids.workspaceId,
    organizationId: ids.organizationId,
    userId: ids.userId,
    playbook: {
      definitionId,
      versionId: null,
      provenance: "draft",
      definitionSnapshot: { name: "Termination review", positions },
    },
    docTypeGate: null,
    projection: PLAYBOOK_RUN_PROJECTION.COLUMNS,
  });
  const run = runs.at(0) ?? panic("The fixture document opened no run");
  return { runId: run.runId, firstPropertyId, secondPropertyId };
};

const removeFixture = async (
  db: GatedTestDb,
  ids: FixtureIds,
): Promise<void> => {
  await deleteOrganizationsForTest(db, [ids.organizationId]);
  await db.delete(user).where(eq(user.id, ids.userId));
};

type Decided = Pick<
  RecordTableRunVerdictsArgs,
  "graded" | "unresolvedPropertyIds"
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
  });
}
