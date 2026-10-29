import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  documentReviewRuns,
  playbookDefinitions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import createPlaybookFromRun from "./create";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("playbook source access on PostgreSQL", () => {
  test("saving a run requires current matter membership and omits response replay", async () => {
    const url = process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(url, async ({ openClient }) => {
      const { db } = openClient();
      const { db: authorizationDb } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const runId = createSafeId<"documentReviewRun">();
      await db.insert(user).values({
        id: userId,
        name: "Review reader",
        email: `${userId}@example.test`,
      });
      await db.insert(organization).values({
        id: organizationId,
        name: "Review organization",
        slug: organizationId,
        createdAt: new Date(),
      });
      try {
        await recordNewOrganizationAccessState(db, { organizationId });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Review matter",
          reference: workspaceId,
        });
        await db.insert(workspaceMembers).values({ workspaceId, userId });
        await db.insert(documentReviewRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          entityId: createSafeId<"entity">(),
          fileFieldId: createSafeId<"field">(),
          entityVersionId: createSafeId<"entityVersion">(),
          contentSha256: "d".repeat(64),
          status: "completed",
          startedAt: new Date(),
          finishedAt: new Date(),
          basis: {
            perspective: { type: "neutral" },
            references: [],
            playbook: {
              definitionId: null,
              versionId: null,
              provenance: "ephemeral",
              definitionSnapshot: {
                name: "Review positions",
                positions: {
                  version: 3,
                  items: [
                    {
                      mode: "graded",
                      sourceId: Bun.randomUUIDv7(),
                      issue: "Notice period",
                      severity: "medium",
                      standard: {
                        source: "tiers",
                        tiers: {
                          acceptable: {
                            rules: [
                              {
                                id: Bun.randomUUIDv7(),
                                text: "At least thirty days notice.",
                              },
                            ],
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
                    },
                  ],
                },
              },
            },
          },
        });
        const options = {
          organizationId,
          userId,
          serverValidatedWorkspaceIds: [],
        };
        const scopedDb = createMembershipScopedDb(markRlsDatabase(db), options);
        const safeDb = createMembershipSafeDb(markRlsDatabase(db), options);
        const authorizationScopedDb = createMembershipScopedDb(
          markRlsDatabase(authorizationDb),
          options,
        );
        const key = Bun.randomUUIDv7();
        const invoke = async (submissionKey: string | null) =>
          await createPlaybookFromRun.handler(
            createTestHandlerContext<
              Parameters<typeof createPlaybookFromRun.handler>[0]
            >({
              audit: async () => undefined,
              scopedDb,
              safeDb,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              memberRole: sessionMemberRole("member"),
              body: { workspaceId, runId },
              query: {},
              params: {},
              route: "/v1/playbooks/from-run",
              getWorkspaceAccess: async (id: SafeId<"workspace">) => {
                const result = await authorizationScopedDb(
                  async (tx) =>
                    await tx.query.workspaces.findFirst({
                      where: { id: { eq: id } },
                      columns: { id: true, status: true },
                    }),
                );
                return result ?? null;
              },
              getActiveWorkspaceIds: async () => [workspaceId],
              request: new Request(
                "https://example.test/v1/playbooks/from-run",
                {
                  method: "POST",
                  headers:
                    submissionKey === null
                      ? {}
                      : { "Idempotency-Key": submissionKey },
                },
              ),
            }),
          );
        const created = await invoke(null);
        expect(created).toHaveProperty("id");
        const keyed = await invoke(key);
        expect(keyed).toBeInstanceOf(HttpStatusResponse);
        if (!(keyed instanceof HttpStatusResponse)) {
          panic("Expected non-replay request refusal");
        }
        expect(keyed.code).toBe(400);
        await db
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, userId),
            ),
          );
        const refused = await invoke(null);
        expect(refused).toBeInstanceOf(HttpStatusResponse);
        if (!(refused instanceof HttpStatusResponse)) {
          panic("Expected current source access refusal");
        }
        expect(refused.code).toBe(404);
        expect(refused.response).toMatchObject({
          message: "Review run not found",
        });
        expect(
          await db.$count(
            playbookDefinitions,
            eq(playbookDefinitions.organizationId, organizationId),
          ),
        ).toBe(1);
      } finally {
        await db
          .delete(workspaces)
          .where(eq(workspaces.organizationId, organizationId));
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
});
