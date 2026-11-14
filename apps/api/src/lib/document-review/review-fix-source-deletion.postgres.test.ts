/**
 * A review's fixes cite the matters their text came from, and deleting one of
 * those matters must leave no such fix behind. The two writes race, and PGlite
 * has a single connection that cannot overlap them, so this needs PostgreSQL.
 */

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { waitForExternalState } from "@stll/property-testing/external-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  documentReviewFindings,
  documentReviewRuns,
  docxSuggestions,
  entities,
  entityVersions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import { finalizeWorkerRun } from "@/api/lib/document-review/run-finalize";
import { lockDocxSuggestionPendingCapacity } from "@/api/lib/docx/suggestion-pending-capacity";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedDocumentReviewRunId } from "@/api/lib/safe-id-boundaries";
import { executeAuthorizedWorkspaceDeletion } from "@/api/lib/workspace-deletion";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { insertOwnerContacts } from "@/api/tests/helpers/owner-contacts";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const POSITION_ID = "22222222-2222-4222-8222-222222222222";
const FINALIZE_CLIENT = "review-fix-finalize";
const DELETION_CLIENT = "review-fix-deletion";

const payloadWithFix: DocumentReviewFindingPayload = {
  finding: {
    positionId: POSITION_ID,
    issue: "Leakage time bar",
    severity: "blocker",
    standardSource: "reference",
    verdict: "deviation",
    delta: { kind: "language" },
    extracted: null,
    rationale: null,
    citations: [{ blockId: "para-4", text: "within 12 months of Completion" }],
    fix: {
      kind: "replaceInBlock",
      blockId: "para-4",
      find: "12 months",
      replace: "6 months",
    },
  },
};

const createFixtureIds = () => ({
  organizationId: mintAuthProviderId<"organization">(),
  userId: mintAuthProviderId<"user">(),
  reviewedWorkspaceId: createSafeId<"workspace">(),
  sourceWorkspaceId: createSafeId<"workspace">(),
  entityId: createSafeId<"entity">(),
  entityVersionId: createSafeId<"entityVersion">(),
  fileFieldId: createSafeId<"field">(),
  runId: createSafeId<"documentReviewRun">(),
});

type FixtureIds = ReturnType<typeof createFixtureIds>;

const basisCiting = (ids: FixtureIds): DocumentReviewRunBasis => ({
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Positions confirmed for this review",
      positions: { version: 3, items: [] },
    },
  },
  perspective: { type: "party", role: "Purchaser", name: null },
  references: [
    {
      workspaceId: ids.sourceWorkspaceId,
      fileFieldId: createSafeId<"field">(),
      entityId: createSafeId<"entity">(),
      entityVersionId: createSafeId<"entityVersion">(),
      contentSha256: "c".repeat(64),
      workspaceName: "Reference matter",
      name: "Reference document",
    },
  ],
});

/** A running review with one fix, whose requester owns both matters. */
const seedRun = async (db: GatedTestDb, ids: FixtureIds): Promise<void> => {
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
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId: ids.organizationId,
    userId: ids.userId,
    role: "owner",
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
  const workspaceIds = [ids.reviewedWorkspaceId, ids.sourceWorkspaceId];
  await db.insert(workspaces).values(
    workspaceIds.map((id) => ({
      id,
      organizationId: ids.organizationId,
      clientId,
      name: "Matter",
      reference: `REF-${id}`,
      status: "active" as const,
    })),
  );
  await db.insert(workspaceMembers).values(
    workspaceIds.map((workspaceId) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId: ids.userId,
    })),
  );
  await db.insert(entities).values({
    id: ids.entityId,
    workspaceId: ids.reviewedWorkspaceId,
    kind: "document",
    name: "agreement",
  });
  await db.insert(entityVersions).values({
    id: ids.entityVersionId,
    workspaceId: ids.reviewedWorkspaceId,
    entityId: ids.entityId,
  });
  await db.insert(documentReviewRuns).values({
    id: ids.runId,
    organizationId: ids.organizationId,
    workspaceId: ids.reviewedWorkspaceId,
    entityId: ids.entityId,
    fileFieldId: ids.fileFieldId,
    entityVersionId: ids.entityVersionId,
    contentSha256: "c".repeat(64),
    basis: basisCiting(ids),
    status: "running",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    total: 1,
    requestedBy: ids.userId,
    executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
  });
  await db.insert(documentReviewFindings).values({
    id: createSafeId<"documentReviewFinding">(),
    organizationId: ids.organizationId,
    workspaceId: ids.reviewedWorkspaceId,
    runId: ids.runId,
    entityId: ids.entityId,
    fileFieldId: ids.fileFieldId,
    entityVersionId: ids.entityVersionId,
    positionId: POSITION_ID,
    positionTitle: payloadWithFix.finding.issue,
    outcome: payloadWithFix.finding.verdict,
    payload: payloadWithFix,
  });
};

type RaceOptions = {
  ids: FixtureIds;
  openClient: GatedTestClientScope["openClient"];
};

const startFinalize = ({ ids, openClient }: RaceOptions) => {
  const { db } = openClient({
    connection: {
      application_name: FINALIZE_CLIENT,
      statement_timeout: 10_000,
    },
  });
  let settled = false;
  const result = finalizeWorkerRun({
    actor: createRootRunActor(
      {
        organizationId: ids.organizationId,
        userId: ids.userId,
        workspaceId: ids.reviewedWorkspaceId,
        runId: ids.runId,
      },
      brandPersistedDocumentReviewRunId,
      markRlsDatabase(db),
    ),
    basis: basisCiting(ids),
    entityId: ids.entityId,
    fileFieldId: ids.fileFieldId,
    expectedFindingCount: 1,
  }).finally(() => {
    settled = true;
  });
  return { result, isSettled: () => settled };
};

type StartDeletionOptions = RaceOptions & {
  beforeCommit?: () => Promise<void>;
};

const startDeletion = ({
  ids,
  openClient,
  beforeCommit,
}: StartDeletionOptions) => {
  const { db } = openClient({
    connection: {
      application_name: DELETION_CLIENT,
      statement_timeout: 10_000,
    },
  });
  let settled = false;
  const result = executeAuthorizedWorkspaceDeletion(
    {
      actorUserId: ids.userId,
      organizationId: ids.organizationId,
      recordAuditEvent: async () => {},
      workspaceId: ids.sourceWorkspaceId,
    },
    {
      database: {
        transaction: async (work) =>
          await db.transaction(async (tx) => {
            const outcome = await work(asTestRaw<Transaction>(tx));
            await beforeCommit?.();
            return outcome;
          }),
      },
      flushWorkspaceSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
    },
  ).finally(() => {
    settled = true;
  });
  return { result, isSettled: () => settled };
};

type AwaitSettledOrBlockedOptions = {
  observer: GatedTestDb;
  clientName: string;
  isSettled: () => boolean;
};

/** A write the fence does not reach simply settles, and the assertions catch it. */
const awaitSettledOrBlocked = async ({
  observer,
  clientName,
  isSettled,
}: AwaitSettledOrBlockedOptions): Promise<void> => {
  await waitForExternalState({
    description: `${clientName} settles or waits on a lock`,
    read: async () => {
      if (isSettled()) {
        return true;
      }
      const rows = await observer.execute<{ blocked: number }>(
        sql`SELECT count(*)::int AS blocked FROM pg_stat_activity
            WHERE application_name = ${clientName}
              AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      return (rows.at(0)?.blocked ?? 0) > 0;
    },
  });
};

const fixesCitingSource = async (db: GatedTestDb, ids: FixtureIds) =>
  await db
    .select({ id: docxSuggestions.id })
    .from(docxSuggestions)
    .where(
      sql`${docxSuggestions.sourceDataWorkspaceIds} @> ARRAY[${ids.sourceWorkspaceId}]::uuid[]`,
    );

const fixesWithheldOn = async (db: GatedTestDb, ids: FixtureIds) => {
  const rows = await db
    .select({ fixesWithheld: documentReviewRuns.fixesWithheld })
    .from(documentReviewRuns)
    .where(eq(documentReviewRuns.id, ids.runId));
  return rows.at(0)?.fixesWithheld;
};

const expectDeleted = (
  outcome: Awaited<ReturnType<typeof executeAuthorizedWorkspaceDeletion>>,
): void => {
  expect(Result.isOk(outcome) ? outcome.value : outcome).toEqual({
    status: "deleted",
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("a reference matter deleted during finalisation", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("a reference matter deleted during finalisation", () => {
    const withSeededRun = async (
      fn: (args: {
        scope: GatedTestClientScope;
        observer: GatedTestDb;
        ids: FixtureIds;
      }) => Promise<void>,
    ): Promise<void> => {
      await withGatedTestClients(databaseUrl, async (scope) => {
        const { db: observer } = scope.openClient();
        const ids = createFixtureIds();
        try {
          await seedRun(observer, ids);
          await fn({ scope, observer, ids });
        } finally {
          await deleteOrganizationsForTest(observer, [ids.organizationId]);
          await observer.delete(user).where(eq(user.id, ids.userId));
        }
      });
    };

    test("withholds the fixes when the deletion got there first", async () => {
      await withSeededRun(async ({ scope: { openClient }, observer, ids }) => {
        const deletionDidItsWork = Promise.withResolvers<undefined>();
        const commitDeletion = Promise.withResolvers<undefined>();
        const deletion = startDeletion({
          ids,
          openClient,
          beforeCommit: async () => {
            deletionDidItsWork.resolve(undefined);
            await commitDeletion.promise;
          },
        });
        await Promise.race([deletionDidItsWork.promise, deletion.result]);

        const finalize = startFinalize({ ids, openClient });
        try {
          await awaitSettledOrBlocked({
            observer,
            clientName: FINALIZE_CLIENT,
            isSettled: finalize.isSettled,
          });
        } finally {
          commitDeletion.resolve(undefined);
        }

        expectDeleted(await deletion.result);
        expect(await finalize.result).toMatchObject({
          type: "completed",
          staged: 0,
          skippedForUnreadableReference: 1,
        });
        expect(await fixesCitingSource(observer, ids)).toEqual([]);
        expect(await fixesWithheldOn(observer, ids)).toBe(1);
      });
    });

    test("removes the staged fixes when finalisation got there first", async () => {
      await withSeededRun(async ({ scope: { openClient }, observer, ids }) => {
        // Staging locks the reviewed document after the fence is taken, so
        // holding that row pauses finalisation with the fence in its hands.
        const { db: holderDb } = openClient();
        const documentHeld = Promise.withResolvers<undefined>();
        const releaseDocument = Promise.withResolvers<undefined>();
        const holder = holderDb.transaction(async (tx) => {
          await lockDocxSuggestionPendingCapacity({
            tx: asTestRaw<Transaction>(tx),
            workspaceId: ids.reviewedWorkspaceId,
            entityId: ids.entityId,
          });
          documentHeld.resolve(undefined);
          await releaseDocument.promise;
        });
        await Promise.race([documentHeld.promise, holder]);

        const finalize = startFinalize({ ids, openClient });
        let deletion: ReturnType<typeof startDeletion> | undefined;
        try {
          await awaitSettledOrBlocked({
            observer,
            clientName: FINALIZE_CLIENT,
            isSettled: finalize.isSettled,
          });
          deletion = startDeletion({ ids, openClient });
          await awaitSettledOrBlocked({
            observer,
            clientName: DELETION_CLIENT,
            isSettled: deletion.isSettled,
          });
        } finally {
          releaseDocument.resolve(undefined);
          await holder;
        }

        expect(await finalize.result).toMatchObject({
          type: "completed",
          staged: 1,
          skippedForUnreadableReference: 0,
        });
        expectDeleted(await deletion.result);
        expect(await fixesCitingSource(observer, ids)).toEqual([]);
      });
    });
  });
}
