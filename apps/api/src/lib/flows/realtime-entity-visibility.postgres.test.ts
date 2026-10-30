import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  resourceRef,
  resourceUpdatedRealtimeEvent,
  workflowExtractionPreviewRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, session, user } from "@/api/db/auth-schema";
import { entities, workspaceMembers, workspaces } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { resolveWorkspaceRealtimeAudience } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  backgroundFeatureActorExists,
  backgroundFeatureMemberExists,
} from "@/api/lib/feature-access/background";
import { flowOwnedEntityVisibilitySql } from "@/api/lib/flows/visibility";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL");

type EventType =
  | typeof REALTIME_EVENT_TYPE.RESOURCE_UPDATED
  | typeof REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW;

type Recipient = {
  sessionId: string;
  userId: SafeId<"user">;
};

const eventFor = (
  eventType: EventType,
  entityId: SafeId<"entity">,
): WorkspaceRealtimeEvent => {
  switch (eventType) {
    case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
      return resourceUpdatedRealtimeEvent(
        resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
      ).toJSON();
    case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
      return workflowExtractionPreviewRealtimeEvent({
        entityId,
        entityVersionId: createSafeId<"entityVersion">(),
        propertyId: createSafeId<"property">(),
        answer: "Draft answer",
        status: "streaming",
      }).toJSON();
    default:
      eventType satisfies never;
      return panic(`Unhandled event type: ${String(eventType)}`);
  }
};

const sorted = (values: Iterable<string>) => [...values].toSorted();

const entityRow = (
  id: SafeId<"entity">,
  workspaceId: SafeId<"workspace">,
  featureOwner: "shared" | "flows",
) => ({
  id,
  workspaceId,
  featureOwner,
  kind: "document" as const,
  name: "Realtime visibility fixture",
});

describe.skipIf(!enabled)(
  "realtime entity visibility parity (postgres)",
  () => {
    test("live events match the owner read for entity updates and workflow previews", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const otherOrganization = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const ordinaryUserId = mintAuthProviderId<"user">();
        const ordinarySessionId = Bun.randomUUIDv7();
        const enrolledSessionId = Bun.randomUUIDv7();
        const siblingWorkspaceId = createSafeId<"workspace">();
        const sharedEntityId = createSafeId<"entity">();
        const flowEntityId = createSafeId<"entity">();
        const siblingMatterEntityId = createSafeId<"entity">();
        const unresolvedEntityId = createSafeId<"entity">();
        const enrolledRecipient = {
          sessionId: enrolledSessionId,
          userId: fixture.userId,
        } satisfies Recipient;
        const ordinaryRecipient = {
          sessionId: ordinarySessionId,
          userId: ordinaryUserId,
        } satisfies Recipient;
        const recipients: Recipient[] = [enrolledRecipient, ordinaryRecipient];
        const previousFlag = env.FEATURE_FLOWS;
        testState.setConfig("FEATURE_FLOWS", true);
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        try {
          await db.insert(user).values({
            id: ordinaryUserId,
            name: "Ordinary workspace member",
            email: `${ordinaryUserId}@example.test`,
            emailVerified: true,
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: fixture.organizationId,
            userId: ordinaryUserId,
            role: "member",
            createdAt: new Date(),
          });
          await db.insert(workspaceMembers).values({
            workspaceId: fixture.workspaceId,
            userId: ordinaryUserId,
          });
          await db.insert(session).values([
            {
              id: enrolledSessionId,
              token: Bun.randomUUIDv7(),
              userId: fixture.userId,
              activeOrganizationId: fixture.organizationId,
              expiresAt: new Date("2100-01-01T00:00:00.000Z"),
            },
            {
              id: ordinarySessionId,
              token: Bun.randomUUIDv7(),
              userId: ordinaryUserId,
              activeOrganizationId: fixture.organizationId,
              expiresAt: new Date("2100-01-01T00:00:00.000Z"),
            },
          ]);
          await db.insert(workspaces).values({
            id: siblingWorkspaceId,
            organizationId: fixture.organizationId,
            name: "Sibling matter",
            reference: siblingWorkspaceId,
          });
          // These sources have no flowRunSteps links; live policy follows the
          // persisted entity owner for every event kind.
          await db
            .insert(entities)
            .values([
              entityRow(sharedEntityId, fixture.workspaceId, "shared"),
              entityRow(flowEntityId, fixture.workspaceId, "flows"),
              entityRow(siblingMatterEntityId, siblingWorkspaceId, "flows"),
            ]);

          const scenarios = [
            {
              name: "shared source reaches both real matter members",
              entityId: sharedEntityId,
              candidates: recipients,
              expectedUserIds: [fixture.userId, ordinaryUserId],
            },
            {
              name: "flow source reaches the currently enrolled member",
              entityId: flowEntityId,
              candidates: recipients,
              expectedUserIds: [fixture.userId],
            },
            {
              name: "flow source is hidden from a member without current enrolment",
              entityId: flowEntityId,
              candidates: [ordinaryRecipient],
              expectedUserIds: [],
            },
            {
              name: "unresolved source is hidden",
              entityId: unresolvedEntityId,
              candidates: recipients,
              expectedUserIds: [],
            },
            {
              name: "source from another matter is hidden",
              entityId: siblingMatterEntityId,
              candidates: recipients,
              expectedUserIds: [],
            },
            {
              name: "source from another organization is hidden",
              entityId: otherOrganization.taskEntityId,
              candidates: recipients,
              expectedUserIds: [],
            },
          ] as const;

          const readPermittedUserIds = async (
            entityId: SafeId<"entity">,
            candidateRecipients: readonly Recipient[],
          ) => {
            const visible: SafeId<"user">[] = [];
            for (const recipient of candidateRecipients) {
              const scopedDb = createScopedDb(
                markRlsDatabase(db),
                [fixture.workspaceId],
                fixture.organizationId,
                recipient.userId,
              );
              const rows = await scopedDb(
                async (tx) =>
                  await tx
                    .select({ id: entities.id })
                    .from(entities)
                    .where(
                      and(
                        eq(entities.id, entityId),
                        eq(entities.workspaceId, fixture.workspaceId),
                        flowOwnedEntityVisibilitySql({
                          organizationId: fixture.organizationId,
                          userId: recipient.userId,
                          entityId: sql`${entities.id}`,
                          workspaceId: sql`${entities.workspaceId}`,
                        }),
                      ),
                    )
                    .limit(1),
              );
              if (rows.length !== 0) {
                visible.push(recipient.userId);
              }
            }
            return visible;
          };

          const liveEventRecipients = async (
            event: WorkspaceRealtimeEvent,
            candidateRecipients: readonly Recipient[],
          ) => {
            const connections = candidateRecipients.map(
              ({ sessionId, userId }) => ({
                sessionId,
                organizationId: fixture.organizationId,
                userId,
              }),
            );
            const authorizations = await resolveWorkspaceRealtimeAudience(
              { connections, workspaceId: fixture.workspaceId, event },
              db,
            );
            const delivered = new Set<SafeId<"user">>();
            for (const connection of connections) {
              const authorization = authorizations.get(connection.sessionId);
              if (
                authorization === undefined ||
                authorization.organizationId !== connection.organizationId ||
                authorization.userId !== connection.userId ||
                authorization.delivery.type === "hidden"
              ) {
                continue;
              }
              delivered.add(connection.userId);
            }
            return delivered;
          };

          const correlatedRecipients = await db
            .select({
              userId: member.userId,
              memberAdmitted: sql<boolean>`${backgroundFeatureMemberExists({ organizationId: member.organizationId, userId: member.userId, featureId: "flows" })}`,
              actorAdmitted: sql<boolean>`${backgroundFeatureActorExists({ organizationId: member.organizationId, userId: member.userId, workspaceId: workspaces.id, featureId: "flows" })}`,
            })
            .from(member)
            .innerJoin(
              workspaces,
              eq(workspaces.organizationId, member.organizationId),
            )
            .where(
              and(
                eq(workspaces.id, fixture.workspaceId),
                inArray(
                  member.userId,
                  recipients.map(({ userId }) => userId),
                ),
              ),
            );
          expect(
            Object.fromEntries(
              correlatedRecipients.map(({ userId, ...admission }) => [
                userId,
                admission,
              ]),
            ),
          ).toEqual(
            Object.fromEntries(
              recipients.map(({ userId }) => [
                userId,
                {
                  memberAdmitted: userId === fixture.userId,
                  actorAdmitted: userId === fixture.userId,
                },
              ]),
            ),
          );

          for (const eventType of [
            REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
            REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
          ] as const) {
            for (const scenario of scenarios) {
              const expectedByRead = await readPermittedUserIds(
                scenario.entityId,
                scenario.candidates,
              );
              expect({
                eventType,
                scenario: scenario.name,
                users: sorted(expectedByRead),
              }).toEqual({
                eventType,
                scenario: scenario.name,
                users: sorted(scenario.expectedUserIds),
              });
              const delivered = await liveEventRecipients(
                eventFor(eventType, scenario.entityId),
                scenario.candidates,
              );
              expect({
                eventType,
                scenario: scenario.name,
                users: sorted(delivered),
              }).toEqual({
                eventType,
                scenario: scenario.name,
                users: sorted(expectedByRead),
              });
            }
          }
        } finally {
          testState.setConfig("FEATURE_FLOWS", previousFlag);
          restoreRuntime();
          await db.delete(user).where(eq(user.id, ordinaryUserId));
          await otherOrganization.cleanup();
          await fixture.cleanup();
        }
      });
    });
  },
);
