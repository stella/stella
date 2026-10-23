import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/node";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  aiMemories,
  organizationSettings,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  AI_MEMORY_FEATURE_ID,
  FEATURE_REGISTRY,
} from "@/api/lib/feature-access/registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import deleteMemory from "./delete";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("memory deletion (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  for (const role of ["intern", "member", "admin", "owner"] as const) {
    test(`memory deletion enforces every scope for ${role} (postgres)`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        try {
          await db.insert(user).values({
            id: userId,
            name: "Memory settings",
            email: `${userId}@example.test`,
            emailVerified: true,
          });
          await db.insert(organization).values({
            id: organizationId,
            name: "Memory settings",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role,
            createdAt: new Date(),
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Memory settings",
            reference: workspaceId,
          });
          await db.insert(workspaceMembers).values({
            id: createSafeId<"workspaceMember">(),
            workspaceId,
            userId,
          });
          await db.insert(organizationSettings).values({ organizationId });
          expect(
            (
              await db
                .select({
                  extraction: organizationSettings.memoryExtractionEnabled,
                })
                .from(organizationSettings)
                .where(eq(organizationSettings.organizationId, organizationId))
            ).at(0)?.extraction,
          ).toBe(false);
          const featureAccessSnapshot = createFeatureAccessSnapshot({
            organizationId,
            userId,
            decisions: new Map([
              [
                AI_MEMORY_FEATURE_ID,
                decideFeatureAccess({
                  registry: FEATURE_REGISTRY,
                  featureId: AI_MEMORY_FEATURE_ID,
                  organizationId,
                  userId,
                  membership: true,
                  user: {
                    email: `${userId}@example.test`,
                    emailVerified: true,
                  },
                  grants: {
                    [AI_MEMORY_FEATURE_ID]: [
                      { type: "organization", organizationId },
                    ],
                  },
                }),
              ],
            ]),
          });
          const safeDb = createSafeDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            userId,
          );
          for (const scope of ["user", "organization", "workspace"] as const) {
            const memoryId = createSafeId<"aiMemory">();
            await db.insert(aiMemories).values({
              id: memoryId,
              organizationId,
              scope,
              userId: scope === "user" ? userId : null,
              workspaceId: scope === "workspace" ? workspaceId : null,
              kind: "instruction",
              content: "Use numbered paragraphs",
              source: "user",
              dedupKey: sha256Hex(memoryId),
              createdBy: userId,
            });
            const allowed =
              scope === "user" ||
              (scope === "workspace"
                ? role !== "intern"
                : role === "admin" || role === "owner");
            const events: string[] = [];
            const result = await deleteMemory.handler(
              createTestHandlerContext<
                Parameters<typeof deleteMemory.handler>[0]
              >({
                audit: auditRecorderDouble((auditEvents) => {
                  for (const event of auditEvents) {
                    events.push(event.action);
                  }
                }),
                safeDb,
                scopedDb: NO_DB,
                featureAccessSnapshot,
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                memberRole: sessionMemberRole(role),
                getAccessibleWorkspaces: async () => [
                  { id: workspaceId, status: "active" },
                ],
                params: { memoryId },
              }),
            );
            expect(result).toEqual(
              allowed
                ? { id: memoryId }
                : { code: 403, response: { message: "Forbidden" } },
            );
            expect(
              await db.$count(aiMemories, eq(aiMemories.id, memoryId)),
            ).toBe(allowed ? 0 : 1);
            expect(events).toEqual(allowed ? ["delete"] : []);
          }
          // Deletion uses the same source-matter policy as reads.
          const derivedId = createSafeId<"aiMemory">();
          await db.insert(aiMemories).values({
            id: derivedId,
            organizationId,
            scope: "user",
            userId,
            kind: "instruction",
            content: "Use numbered paragraphs",
            source: "user",
            dedupKey: sha256Hex(derivedId),
            sourceDataWorkspaceIds: [workspaceId],
            createdBy: userId,
          });
          await db
            .delete(workspaceMembers)
            .where(eq(workspaceMembers.workspaceId, workspaceId));
          const restricted = createSafeDb(
            markRlsDatabase(db),
            [],
            organizationId,
            userId,
          );
          const result = await restricted(
            async (tx) =>
              await tx
                .delete(aiMemories)
                .where(eq(aiMemories.id, derivedId))
                .returning({ id: aiMemories.id }),
          );
          expect(result.unwrap()).toEqual([]);
          expect(
            await db.$count(aiMemories, eq(aiMemories.id, derivedId)),
          ).toBe(1);
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  }
}
