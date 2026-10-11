import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  legalLists,
  legalListColumns,
  legalListItems,
  legalListFactDetails,
  legalListGenerationRuns,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListVerificationRuns,
  legalListClaims,
  properties,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  readClaimForReview,
  readClaimsForBulkReview,
} from "@/api/lib/lists/verification/read-run";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import createColumn from "./columns/create";
import createList from "./create";
import {
  lockAcceptanceCandidate,
  lockAcceptanceFinalization,
} from "./generation-candidates/acceptance/transactions";
import rejectCandidate from "./generation-candidates/rejection/create";
import updateFactDetails from "./items/fact-details/update";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const testState = createTestState({ file: import.meta.path, config: env });
const audit = auditRecorderDouble();
const joinedSafeDb =
  (tx: Transaction): SafeDb =>
  async (operation) =>
    Result.ok(await operation(tx));

const withFixture = async (
  url: string,
  run: (fixture: Awaited<ReturnType<typeof seedFixture>>) => Promise<void>,
) => {
  await withGatedTestClients(url, async ({ openClient }) => {
    const db = openClient().db;
    const fixture = await seedFixture(db);
    try {
      testState.setConfig("FEATURE_LEGAL_LISTS", true);
      testState.setConfig(
        "API_FEATURE_ACCESS_GRANTS",
        organizationFeatureGrants(fixture.organizationId, [
          "legal-lists",
          "list-verification",
        ]),
      );
      await run(fixture);
    } finally {
      await db
        .delete(organization)
        .where(eq(organization.id, fixture.organizationId));
      await db.delete(user).where(eq(user.id, fixture.userId));
    }
  });
};

const seedFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const listId = createSafeId<"legalList">();
  const runId = createSafeId<"legalListGenerationRun">();
  const candidateId = createSafeId<"legalListGenerationCandidate">();
  const entityId = createSafeId<"entity">();
  const sourceEntityId = createSafeId<"entity">();
  const sourceVersionId = createSafeId<"entityVersion">();
  const sourceId = createSafeId<"legalListGenerationCandidateSource">();
  const verificationRunId = createSafeId<"legalListVerificationRun">();
  const claimIds = [
    createSafeId<"legalListClaim">(),
    createSafeId<"legalListClaim">(),
  ].toSorted();
  await db.insert(organization).values({
    id: organizationId,
    name: "Lifecycle barrier fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Lifecycle fixture",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Lifecycle fixture",
    reference: workspaceId,
  });
  await db.insert(legalLists).values({
    id: listId,
    workspaceId,
    name: "Lifecycle fixture",
    createdBy: userId,
  });
  await db.insert(entities).values([
    {
      id: entityId,
      workspaceId,
      kind: "task",
      listItemType: "fact",
      name: "Fact fixture",
    },
    {
      id: sourceEntityId,
      workspaceId,
      kind: "document",
      name: "Source fixture",
    },
  ]);
  await db.insert(entityVersions).values({
    id: sourceVersionId,
    workspaceId,
    entityId: sourceEntityId,
    versionNumber: 1,
  });
  await db.insert(legalListItems).values({
    entityId,
    workspaceId,
    listId,
    position: entityId,
    addedBy: userId,
  });
  await db.insert(legalListFactDetails).values({
    itemEntityId: entityId,
    workspaceId,
    listId,
    confidence: "high",
    scoring: "included",
    updatedBy: userId,
  });
  await db.insert(legalListGenerationRuns).values({
    id: runId,
    workspaceId,
    listId,
    status: "review",
    instruction: "Fixture",
    requestedBy: userId,
  });
  await db.insert(legalListGenerationCandidates).values({
    id: candidateId,
    workspaceId,
    listId,
    runId,
    position: 0,
    name: "Fixture",
    itemType: "fact",
    status: "accepting",
    reservedEntityId: entityId,
  });
  await db.insert(legalListGenerationCandidateSources).values({
    id: sourceId,
    workspaceId,
    listId,
    runId,
    candidateId,
    sourceEntityId,
    sourceEntityVersionId: sourceVersionId,
    locator: { type: "document" },
    quote: "Fixture",
  });
  await db.insert(legalListVerificationRuns).values({
    id: verificationRunId,
    workspaceId,
    organizationId,
    entityId: sourceEntityId,
    entityVersionId: sourceVersionId,
    fileFieldId: createSafeId<"field">(),
    contentSha256: "a".repeat(64),
    evidence: { listId, facts: [] },
    status: "completed",
    pipelineVersion: 2,
  });
  await db.insert(legalListClaims).values(
    claimIds.map((id, position) => ({
      id,
      workspaceId,
      runId: verificationRunId,
      position,
      type: "fact" as const,
      state: "nocover" as const,
      text: "Fixture",
      anchor: { type: "pdf-page" as const, pageNumber: 1, start: 0, end: 7 },
      refs: [],
    })),
  );
  return {
    db,
    organizationId,
    userId,
    workspaceId,
    listId,
    runId,
    candidateId,
    entityId,
    sourceId,
    claimIds,
    verificationRunId,
  };
};

type Fixture = Awaited<ReturnType<typeof seedFixture>>;
type BarrierOptions<State> = {
  url: string;
  hold: (tx: Transaction) => Promise<unknown>;
  contend: (tx: Transaction) => Promise<unknown>;
  readState: () => Promise<State>;
  verify: (state: State) => void;
};
const assertBarrier = async <State>({
  url,
  hold,
  contend,
  readState,
  verify,
}: BarrierOptions<State>) => {
  await withInterleaving({
    databaseUrl: url,
    schedules: [["a.hold", "b.wait", "a.commit", "b.commit"]],
    a: { steps: [{ name: "hold", run: hold }] },
    b: { steps: [{ name: "wait", run: contend }] },
    reset: async () => {},
    readState,
    invariant: ({ blocked, sessions, outcomes, state }) => {
      expect(sessions.a.pid).not.toBe(sessions.b.pid);
      expect(blocked).toEqual(["b.wait"]);
      expect(outcomes.a).toEqual({ status: "committed" });
      expect(outcomes.b).toEqual({ status: "committed" });
      verify(state);
    },
  });
};
const context = (fixture: Fixture, tx: Transaction) => ({
  workspaceId: fixture.workspaceId,
  session: { activeOrganizationId: fixture.organizationId },
  user: { id: fixture.userId },
  safeDb: joinedSafeDb(tx),
  scopedDb: NO_DB,
  audit,
});

if (!databaseUrl || !enabled) {
  describe.skip("list lifecycle aggregate barriers (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("list lifecycle aggregate barriers (postgres)", () => {
    test("list admission waits and recounts after the final slot commits", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        await fixture.db.insert(legalLists).values(
          Array.from({ length: LIMITS.legalListsPerWorkspace - 2 }, () => ({
            id: createSafeId<"legalList">(),
            workspaceId: fixture.workspaceId,
            name: "Capacity fixture",
          })),
        );
        const create = async (tx: Transaction) =>
          await createList.handler(
            createTestHandlerContext<Parameters<typeof createList.handler>[0]>({
              ...context(fixture, tx),
              body: { name: "Final slot" },
            }),
          );
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) => {
            expect(await create(tx)).not.toBeInstanceOf(
              ElysiaCustomStatusResponse,
            );
          },
          contend: async (tx) => {
            expect(await create(tx)).toMatchObject({
              code: 400,
              response: { message: "Lists limit reached for this workspace" },
            });
          },
          readState: async () =>
            fixture.db.$count(
              legalLists,
              eq(legalLists.workspaceId, fixture.workspaceId),
            ),
          verify: (count) => expect(count).toBe(LIMITS.legalListsPerWorkspace),
        });
      });
    });

    test("column admission waits and recounts after the final slot commits", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        const ids = Array.from(
          { length: LIMITS.legalListColumnsPerList + 1 },
          () => createSafeId<"property">(),
        );
        await fixture.db.insert(properties).values(
          ids.map((id) => ({
            id,
            workspaceId: fixture.workspaceId,
            name: id,
            status: "fresh" as const,
            content: { version: 1 as const, type: "text" as const },
            tool: { version: 1 as const, type: "manual-input" as const },
          })),
        );
        await fixture.db.insert(legalListColumns).values(
          ids.slice(0, -2).map((propertyId, position) => ({
            id: createSafeId<"legalListColumn">(),
            workspaceId: fixture.workspaceId,
            listId: fixture.listId,
            propertyId,
            position,
          })),
        );
        const create = async (
          tx: Transaction,
          propertyId: (typeof ids)[number],
        ) =>
          await createColumn.handler(
            createTestHandlerContext<
              Parameters<typeof createColumn.handler>[0]
            >({
              ...context(fixture, tx),
              body: { listId: fixture.listId, propertyId },
            }),
          );
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) => {
            expect(
              await create(
                tx,
                ids.at(-2) ?? panic("Final slot property missing"),
              ),
            ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
          },
          contend: async (tx) => {
            expect(
              await create(
                tx,
                ids.at(-1) ?? panic("Overflow property missing"),
              ),
            ).toMatchObject({ code: 400 });
          },
          readState: async () =>
            fixture.db.$count(
              legalListColumns,
              eq(legalListColumns.listId, fixture.listId),
            ),
          verify: (count) => expect(count).toBe(LIMITS.legalListColumnsPerList),
        });
      });
    });

    test("cleanup acquisition waits for acceptance and reads the committed accepted candidate", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) =>
            tx
              .update(legalListGenerationCandidates)
              .set({
                status: "accepted",
                acceptedEntityId: fixture.entityId,
                acceptedEntityWorkspaceId: fixture.workspaceId,
                reservedEntityId: null,
              })
              .where(eq(legalListGenerationCandidates.id, fixture.candidateId)),
          contend: async (tx) => {
            const result = await lockAcceptanceCandidate({
              tx,
              body: fixture,
              workspaceId: fixture.workspaceId,
            });
            expect(result).toMatchObject({
              status: "accepted",
              acceptedEntityId: fixture.entityId,
              reservedEntityId: null,
            });
          },
          readState: async () =>
            fixture.db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, fixture.entityId)),
          verify: (rows) => expect(rows).toEqual([{ id: fixture.entityId }]),
        });
      });
    });

    test("finalization waits on an unclaimed live source and rejects the full changed source set", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) =>
            tx
              .update(legalListGenerationCandidateSources)
              .set({ quote: "Changed while finalizing" })
              .where(
                eq(legalListGenerationCandidateSources.id, fixture.sourceId),
              ),
          contend: async (tx) => {
            expect(
              await lockAcceptanceFinalization({
                body: fixture,
                claimedSources: [],
                entityId: fixture.entityId,
                tx,
                workspaceId: fixture.workspaceId,
              }),
            ).toEqual({ status: "source-missing" });
          },
          readState: async () =>
            fixture.db
              .select({ status: legalListGenerationCandidates.status })
              .from(legalListGenerationCandidates)
              .where(eq(legalListGenerationCandidates.id, fixture.candidateId)),
          verify: (rows) => expect(rows).toEqual([{ status: "accepting" }]),
        });
      });
    });

    test("rejection waits on the run and then rejects the pending candidate", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        await fixture.db
          .update(legalListGenerationCandidates)
          .set({ status: "pending", reservedEntityId: null })
          .where(eq(legalListGenerationCandidates.id, fixture.candidateId));
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) =>
            tx
              .update(legalListGenerationRuns)
              .set({ instruction: "Changed" })
              .where(eq(legalListGenerationRuns.id, fixture.runId)),
          contend: async (tx) => {
            expect(
              await rejectCandidate.handler(
                createTestHandlerContext<
                  Parameters<typeof rejectCandidate.handler>[0]
                >({ ...context(fixture, tx), body: fixture }),
              ),
            ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
          },
          readState: async () =>
            fixture.db
              .select({ status: legalListGenerationRuns.status })
              .from(legalListGenerationRuns)
              .where(eq(legalListGenerationRuns.id, fixture.runId)),
          verify: (rows) => expect(rows).toEqual([{ status: "committed" }]),
        });
      });
    });

    test("fact update waits and observes the prior writer's committed detail", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        const recorded: unknown[] = [];
        const factAudit = auditRecorderDouble((events) => {
          recorded.push(...events);
        });
        const body = {
          listId: fixture.listId,
          itemEntityId: fixture.entityId,
          occurredOn: null,
          evidenceKind: null,
          medium: "paper",
          confidence: "high" as const,
          interpretationNote: null,
          scoring: "included" as const,
        };
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) =>
            tx
              .update(legalListFactDetails)
              .set({ medium: "paper" })
              .where(eq(legalListFactDetails.itemEntityId, fixture.entityId)),
          contend: async (tx) => {
            expect(
              await updateFactDetails.handler(
                createTestHandlerContext<
                  Parameters<typeof updateFactDetails.handler>[0]
                >({ ...context(fixture, tx), audit: factAudit, body }),
              ),
            ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
            expect(recorded).toEqual([]);
          },
          readState: async () =>
            fixture.db
              .select({ medium: legalListFactDetails.medium })
              .from(legalListFactDetails)
              .where(eq(legalListFactDetails.itemEntityId, fixture.entityId)),
          verify: (rows) => expect(rows).toEqual([{ medium: "paper" }]),
        });
      });
    });

    test("single review waits and reads the committed claim state", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        const claimId = fixture.claimIds.at(0) ?? panic("Review claim missing");
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) =>
            tx
              .update(legalListClaims)
              .set({ state: "supported", score: 100 })
              .where(eq(legalListClaims.id, claimId)),
          contend: async (tx) => {
            expect(
              await readClaimForReview({
                tx,
                workspaceId: fixture.workspaceId,
                runId: fixture.verificationRunId,
                claimId,
              }),
            ).toMatchObject({ state: "supported", recordConflict: null });
          },
          readState: async () =>
            fixture.db
              .select({ state: legalListClaims.state })
              .from(legalListClaims)
              .where(eq(legalListClaims.id, claimId)),
          verify: (rows) => expect(rows).toEqual([{ state: "supported" }]),
        });
      });
    });

    test("overlapping bulk review waits in physical order and retains every selected claim", async () => {
      await withFixture(databaseUrl, async (fixture) => {
        const read = async (tx: Transaction) =>
          await readClaimsForBulkReview({
            tx,
            workspaceId: fixture.workspaceId,
            runId: fixture.verificationRunId,
            claimIds: fixture.claimIds.toReversed(),
          });
        await assertBarrier({
          url: databaseUrl,
          hold: async (tx) => {
            expect((await read(tx)).map((row) => row.id)).toEqual(
              fixture.claimIds,
            );
          },
          contend: async (tx) => {
            expect((await read(tx)).map((row) => row.id)).toEqual(
              fixture.claimIds,
            );
          },
          readState: async () =>
            fixture.db.$count(
              legalListClaims,
              eq(legalListClaims.runId, fixture.verificationRunId),
            ),
          verify: (count) => expect(count).toBe(2),
        });
      });
    });
  });
}
