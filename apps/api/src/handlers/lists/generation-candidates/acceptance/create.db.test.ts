import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import type { ListItemType } from "@stll/api-contract/entity-options";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
  legalListItems,
  legalLists,
  workObligations,
  workspaces,
} from "@/api/db/schema";
import type acceptGenerationCandidateDefinition from "@/api/handlers/lists/generation-candidates/acceptance/create";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

/**
 * Accepting a generation candidate reserves the candidate, materializes a task
 * entity, then finalizes. When finalization gives up, the compensator releases
 * the reservation, and whether it may also delete the entity depends on who
 * created that entity: `legal_list_items_entity_fk` cascades, so deleting an
 * entity an earlier attempt already committed takes a live list item, its
 * sources, and its assignees with it. Only a real database shows that cascade,
 * so this pair drives the handler against one, over the same `source-missing`
 * compensation path, differing only in who owns the entity.
 */

type AcceptGenerationCandidate = typeof acceptGenerationCandidateDefinition;
type AcceptGenerationCandidateCtx = Parameters<
  AcceptGenerationCandidate["handler"]
>[0];

let testDb: TestDatabase;
let acceptGenerationCandidate: AcceptGenerationCandidate;
let acceptGovernedCandidate: AcceptGenerationCandidate;
const seededOrganizationIds: SafeId<"organization">[] = [];

beforeAll(
  async () => {
    testDb = await getTestDb();
    // The handler materializes its entity through the shared task-creation
    // path, which is gated on the deployed feature flags. Legal Lists must be
    // on for the created-here control to reach entity creation at all, and the
    // governed variant additionally turns on the obligation sidecar.
    const { createAcceptGenerationCandidate } =
      await import("@/api/handlers/lists/generation-candidates/acceptance/create");
    const { createTaskEntityHandler } =
      await import("@/api/lib/tasks/create-task-entity");
    acceptGenerationCandidate = createAcceptGenerationCandidate({
      createTaskEntityHandler: (props) =>
        createTaskEntityHandler({
          ...props,
          features: { governedWorkflow: false, legalLists: true },
        }),
    });
    acceptGovernedCandidate = createAcceptGenerationCandidate({
      createTaskEntityHandler: (props) =>
        createTaskEntityHandler({
          ...props,
          features: { governedWorkflow: true, legalLists: true },
        }),
    });
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (seededOrganizationIds.length > 0) {
    await testDb
      .delete(organization)
      .where(inArray(organization.id, seededOrganizationIds));
  }
  await releaseTestDb();
});

const noAuditRows: AuditRecorder = async () => undefined;

/**
 * A `SafeDb` over the test database, matching the scoped factories' contract:
 * anything the callback throws that is not a driver error comes back wrapped,
 * carrying the thrown value as its cause.
 */
const testSafeDb: SafeDb = async (fn) =>
  await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        return await fn(asTestRaw<Transaction>(tx));
      }),
    catch: (cause) =>
      new DatabaseError({ message: "test transaction failed", cause }),
  });

/**
 * Which acceptance attempt owns the reserved entity when the handler runs.
 *
 * - `adopted`: an earlier attempt already committed the entity and its list
 *   item, and left the candidate reserved against it.
 * - `created-here`: nothing exists yet, so this request creates the entity.
 */
type SeededOwnership = "adopted" | "created-here";

type SeededAcceptance = {
  candidateId: SafeId<"legalListGenerationCandidate">;
  citedEntityId: SafeId<"entity"> | null;
  listId: SafeId<"legalList">;
  organizationId: SafeId<"organization">;
  reservedEntityId: SafeId<"entity"> | null;
  runId: SafeId<"legalListGenerationRun">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Whether the candidate cites anything.
 *
 * - `none`: no candidate-source rows at all. The finalizing transaction
 *   compares the live sources against the set the claim captured and reports
 *   `source-missing` when there are none, which is the compensation path the
 *   ownership pair needs.
 * - `cited`: two source documents, so "the first source" is a choice the
 *   handler has to make deterministically rather than an accident of a
 *   single-row table.
 */
type SeededSources = "none" | "cited";

type SeedAcceptanceOptions = {
  itemType: ListItemType;
  ownership: SeededOwnership;
  sources: SeededSources;
};

const seedSourceDocument = async (
  tx: TestDatabaseTransaction,
  workspaceId: SafeId<"workspace">,
  userId: SafeId<"user">,
) => {
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  await tx.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: `Cited document ${entityId}`,
    createdBy: userId,
  });
  await tx.insert(entityVersions).values({
    id: versionId,
    workspaceId,
    entityId,
    versionNumber: 1,
  });
  await tx
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
  return { entityId, versionId };
};

/** A run with one candidate, seeded for the branch a test drives. */
const seedAcceptance = async ({
  itemType,
  ownership,
  sources,
}: SeedAcceptanceOptions): Promise<SeededAcceptance> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  const listId = createSafeId<"legalList">();
  const runId = createSafeId<"legalListGenerationRun">();
  const candidateId = createSafeId<"legalListGenerationCandidate">();
  const reservedEntityId =
    ownership === "adopted" ? createSafeId<"entity">() : null;
  let citedEntityId: SafeId<"entity"> | null = null;

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Candidate acceptance matter",
      slug: `candidate-acceptance-${Bun.randomUUIDv7()}`,
      createdAt: new Date(),
    });
    await tx.insert(user).values({
      id: userId,
      name: "Candidate Acceptance User",
      email: `${userId}@example.test`,
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Candidate acceptance matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(legalLists).values({
      id: listId,
      workspaceId,
      name: "Chronology",
      status: "active",
      createdBy: userId,
    });
    await tx.insert(legalListGenerationRuns).values({
      id: runId,
      workspaceId,
      listId,
      status: "review",
      instruction: "Draft a chronology from the pleadings.",
      requestedBy: userId,
    });
    await tx.insert(legalListGenerationCandidates).values({
      id: candidateId,
      workspaceId,
      listId,
      runId,
      position: 1,
      name: "Statement of claim filed",
      description: "Filed with the court.",
      itemType,
      status: reservedEntityId ? "accepting" : "pending",
      reservedEntityId,
    });

    if (sources === "cited") {
      const first = await seedSourceDocument(tx, workspaceId, userId);
      const second = await seedSourceDocument(tx, workspaceId, userId);
      const rows = [
        { id: createSafeId<"legalListGenerationCandidateSource">(), ...first },
        { id: createSafeId<"legalListGenerationCandidateSource">(), ...second },
      ];
      await tx.insert(legalListGenerationCandidateSources).values(
        rows.map((row) => ({
          id: row.id,
          workspaceId,
          listId,
          runId,
          candidateId,
          sourceEntityId: row.entityId,
          sourceEntityVersionId: row.versionId,
          locator: { type: "document" as const },
          quote: "Filed with the court.",
        })),
      );
      citedEntityId =
        rows.toSorted((left, right) => (left.id < right.id ? -1 : 1)).at(0)
          ?.entityId ?? null;
    }

    if (!reservedEntityId) {
      return;
    }

    // What the interrupted attempt already committed: the entity, its version,
    // and the list item that makes it live user data.
    const entityVersionId = createSafeId<"entityVersion">();
    await tx.insert(entities).values({
      id: reservedEntityId,
      workspaceId,
      kind: "task",
      listItemType: itemType,
      name: "Statement of claim filed",
      createdBy: userId,
      agendaKind: "task",
      status: "open",
      priority: "none",
      agendaSource: "manual",
    });
    await tx.insert(entityVersions).values({
      id: entityVersionId,
      workspaceId,
      entityId: reservedEntityId,
      versionNumber: 1,
    });
    await tx
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, reservedEntityId));
    await tx.insert(legalListItems).values({
      entityId: reservedEntityId,
      workspaceId,
      listId,
      position: reservedEntityId,
      description: "Filed with the court.",
      addedBy: userId,
    });
  });

  seededOrganizationIds.push(organizationId);
  return {
    candidateId,
    citedEntityId,
    listId,
    organizationId,
    reservedEntityId,
    runId,
    userId,
    workspaceId,
  };
};

const runAcceptance = async (
  accept: AcceptGenerationCandidate,
  seeded: SeededAcceptance,
) =>
  await accept.handler(
    asTestRaw<AcceptGenerationCandidateCtx>({
      body: {
        listId: seeded.listId,
        runId: seeded.runId,
        candidateId: seeded.candidateId,
      },
      memberRole: { role: "owner" },
      recordAuditEvent: noAuditRows,
      request: new Request("https://example.test/v1/lists/candidates/accept", {
        method: "POST",
      }),
      route: "/v1/lists/candidates/accept",
      safeDb: testSafeDb,
      session: { activeOrganizationId: seeded.organizationId },
      user: { id: seeded.userId },
      workspaceId: seeded.workspaceId,
    }),
  );

const acceptCandidate = async (seeded: SeededAcceptance) =>
  await runAcceptance(acceptGenerationCandidate, seeded);

const acceptGoverned = async (seeded: SeededAcceptance) =>
  await runAcceptance(acceptGovernedCandidate, seeded);

/** The rejection the compensation path answers with, on both ownerships. */
const SOURCE_MISSING_REJECTION = {
  code: 409,
  response: { message: "Candidate source is no longer available" },
} as const;

const taskEntityCount = async (seeded: SeededAcceptance) =>
  await testDb.$count(
    entities,
    and(
      eq(entities.workspaceId, seeded.workspaceId),
      eq(entities.kind, "task"),
    ),
  );

const listItemCount = async (seeded: SeededAcceptance) =>
  await testDb.$count(
    legalListItems,
    eq(legalListItems.workspaceId, seeded.workspaceId),
  );

const candidateReservation = async (seeded: SeededAcceptance) =>
  (
    await testDb
      .select({
        reservedEntityId: legalListGenerationCandidates.reservedEntityId,
        status: legalListGenerationCandidates.status,
      })
      .from(legalListGenerationCandidates)
      .where(eq(legalListGenerationCandidates.id, seeded.candidateId))
  ).at(0);

test("releasing an adopted reservation keeps the committed item alive", async () => {
  const seeded = await seedAcceptance({
    itemType: LIST_ITEM_TYPE.TASK,
    ownership: "adopted",
    sources: "none",
  });

  expect(await acceptCandidate(seeded)).toEqual(SOURCE_MISSING_REJECTION);

  // The entity and the list item belong to the earlier attempt, not to this
  // request: deleting the entity would cascade the item away through
  // legal_list_items_entity_fk.
  expect(await taskEntityCount(seeded)).toBe(1);
  expect(await listItemCount(seeded)).toBe(1);
  expect(await candidateReservation(seeded)).toEqual({
    reservedEntityId: null,
    status: "pending",
  });
});

// The control: without it, "the entity survived" would also pass on a
// compensator that never deletes anything.
test("releasing a reservation this request created deletes its entity", async () => {
  const seeded = await seedAcceptance({
    itemType: LIST_ITEM_TYPE.TASK,
    ownership: "created-here",
    sources: "none",
  });

  expect(await acceptCandidate(seeded)).toEqual(SOURCE_MISSING_REJECTION);

  expect(await taskEntityCount(seeded)).toBe(0);
  expect(await listItemCount(seeded)).toBe(0);
  expect(await candidateReservation(seeded)).toEqual({
    reservedEntityId: null,
    status: "pending",
  });
});

/** Accept under governance, failing the test rather than the assertion when the
 * handler answers with a rejection instead of the created item. */
const acceptGovernedEntityId = async (seeded: SeededAcceptance) => {
  const accepted = await acceptGoverned(seeded);
  if (!isRecord(accepted) || typeof accepted.entityId !== "string") {
    throw new Error(`acceptance rejected: ${JSON.stringify(accepted)}`);
  }
  return toSafeId<"entity">(accepted.entityId);
};

const workObligationOf = async (entityId: SafeId<"entity">) =>
  (
    await testDb
      .select({
        sourceType: workObligations.sourceType,
        sourceEntityId: workObligations.sourceEntityId,
      })
      .from(workObligations)
      .where(eq(workObligations.entityId, entityId))
  ).at(0);

test("an accepted actionable candidate is governed by the document it cites", async () => {
  const seeded = await seedAcceptance({
    itemType: LIST_ITEM_TYPE.TASK,
    ownership: "created-here",
    sources: "cited",
  });

  expect(seeded.citedEntityId).not.toBeNull();
  expect(await workObligationOf(await acceptGovernedEntityId(seeded))).toEqual({
    sourceType: "document",
    sourceEntityId: seeded.citedEntityId,
  });
});

// The eligibility guard: reference rows carry the same cited sources, so only
// the item type keeps them out of governed work.
test("an accepted fact candidate gains no governed work", async () => {
  const seeded = await seedAcceptance({
    itemType: LIST_ITEM_TYPE.FACT,
    ownership: "created-here",
    sources: "cited",
  });

  expect(
    await workObligationOf(await acceptGovernedEntityId(seeded)),
  ).toBeUndefined();
  expect(await listItemCount(seeded)).toBe(1);
});
