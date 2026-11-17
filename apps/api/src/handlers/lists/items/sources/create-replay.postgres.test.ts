import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  legalGraphEdges,
  legalListItems,
  legalListItemSources,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

import createItemSource from "./create";

const testState = createTestState({ file: import.meta.path, config: env });
const clock = createTestClock();
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("list source create replay (postgres)", () => {
  test("a lost response replays one source and graph edge without another audit event", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const factId = createSafeId<"entity">();
      const documentId = createSafeId<"entity">();
      const versionId = createSafeId<"entityVersion">();
      const nextVersionId = createSafeId<"entityVersion">();
      testState.setConfig("FEATURE_LEGAL_LISTS", true);
      testState.setConfig(
        "API_FEATURE_ACCESS_GRANTS",
        organizationFeatureGrants(organizationId, [LEGAL_LISTS_FEATURE_ID]),
      );
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Source replay",
          slug: organizationId,
          createdAt: new Date(clock.now()),
        });
        await db.insert(user).values({
          id: userId,
          name: "Source author",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(clock.now()),
        });
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Source replay matter",
          reference: workspaceId,
        });
        await db.insert(legalLists).values({
          id: listId,
          workspaceId,
          name: "Anchor facts",
          createdBy: userId,
        });
        await db.insert(entities).values([
          {
            id: factId,
            workspaceId,
            name: "The notice was delivered.",
            kind: "task",
            listItemType: LIST_ITEM_TYPE.FACT,
            createdBy: userId,
            agendaKind: "task",
            status: "open",
            priority: "none",
            agendaSource: "manual",
          },
          {
            id: documentId,
            workspaceId,
            name: "Notice.pdf",
            kind: "document",
            createdBy: userId,
          },
        ]);
        await db.insert(entityVersions).values([
          {
            id: versionId,
            workspaceId,
            entityId: documentId,
            versionNumber: 1,
          },
          {
            id: nextVersionId,
            workspaceId,
            entityId: documentId,
            versionNumber: 2,
          },
        ]);
        await db.insert(legalListItems).values({
          entityId: factId,
          workspaceId,
          listId,
          position: "a",
          addedBy: userId,
        });
        const scopedDb = createScopedDb(
          db,
          [workspaceId],
          organizationId,
          userId,
        );
        const featureAccessSnapshot = createFeatureAccessSnapshot({
          organizationId,
          userId,
          decisions: new Map([
            [
              LEGAL_LISTS_FEATURE_ID,
              decideFeatureAccess({
                registry: FEATURE_REGISTRY,
                featureId: LEGAL_LISTS_FEATURE_ID,
                organizationId,
                userId,
                membership: true,
                user: { email: `${userId}@example.test`, emailVerified: true },
                grants: {
                  [LEGAL_LISTS_FEATURE_ID]: [
                    { type: "organization", organizationId },
                  ],
                },
              }),
            ],
          ]),
        });
        const body = {
          listId,
          itemEntityId: factId,
          sourceEntityId: documentId,
          sourceEntityVersionId: versionId,
          locator: { type: "document" as const },
          quote: "Delivered",
        };
        let auditEvents = 0;
        const audit = auditRecorderDouble((events) => {
          auditEvents += events.length;
        });
        const invoke = async (key: string, sourceEntityVersionId = versionId) =>
          await createItemSource.handler(
            createTestHandlerContext<
              Parameters<typeof createItemSource.handler>[0]
            >({
              scopedDb,
              safeDb: safeDbFromScoped(scopedDb),
              audit,
              memberRole: sessionMemberRole("owner"),
              workspaceId,
              featureAccessSnapshot,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              body: { ...body, sourceEntityVersionId },
              params: { workspaceId },
              query: {},
              route: "/lists/:workspaceId/item-sources",
              set: { headers: {} },
              request: new Request(
                `https://example.test/v1/lists/${workspaceId}/item-sources`,
                { method: "POST", headers: { "Idempotency-Key": key } },
              ),
            }),
          );
        const stored = async () =>
          await scopedDb(async (tx) => ({
            sources: await tx
              .select({ total: count() })
              .from(legalListItemSources)
              .where(eq(legalListItemSources.workspaceId, workspaceId)),
            edges: await tx
              .select({ total: count() })
              .from(legalGraphEdges)
              .where(eq(legalGraphEdges.workspaceId, workspaceId)),
          }));
        const first = await invoke("source-lost-response");
        if (first instanceof Response || !("id" in first)) {
          panic("The first source was not created");
        }
        const replay = await invoke("source-lost-response");
        if (!(replay instanceof Response)) {
          panic("The retry wrote another source instead of replaying");
        }
        expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
        expect(await replay.json()).toEqual({ id: first.id });
        const afterReplay = await stored();
        expect(afterReplay.sources.at(0)?.total).toBe(1);
        expect(afterReplay.edges.at(0)?.total).toBe(1);
        expect(auditEvents).toBe(1);

        const changed = await invoke("source-lost-response", nextVersionId);
        expect(changed).toMatchObject({
          code: 422,
          response: { code: "idempotency_key_reused" },
        });
        expect(await stored()).toEqual(afterReplay);
        expect(auditEvents).toBe(1);

        const second = await invoke("source-new-intent", nextVersionId);
        if (second instanceof Response || !("id" in second)) {
          panic("A new intent did not create its source");
        }
        expect(second.id).not.toBe(first.id);
        const afterSecond = await stored();
        expect(afterSecond.sources.at(0)?.total).toBe(2);
        expect(afterSecond.edges.at(0)?.total).toBe(2);
        expect(auditEvents).toBe(2);
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
});
