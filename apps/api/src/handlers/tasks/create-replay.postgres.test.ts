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
  legalListItems,
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

import { createTaskForFeatures } from "./create";

const testState = createTestState({ file: import.meta.path, config: env });
const clock = createTestClock();
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const createTask = createTaskForFeatures({
  governedWorkflow: false,
  legalLists: true,
});

describe.skipIf(!enabled)("list item create replay (postgres)", () => {
  test("a retried fact create replays the first item and a new key adds another", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      testState.setConfig("FEATURE_LEGAL_LISTS", true);
      testState.setConfig(
        "API_FEATURE_ACCESS_GRANTS",
        organizationFeatureGrants(organizationId, [LEGAL_LISTS_FEATURE_ID]),
      );

      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "List item replay",
          slug: organizationId,
          createdAt: new Date(clock.now()),
        });
        await db.insert(user).values({
          id: userId,
          name: "List item author",
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
          name: "List item replay matter",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(legalLists).values({
          id: listId,
          workspaceId,
          name: "Anchor facts",
          createdBy: userId,
        });

        const scopedDb = createScopedDb(
          db,
          [workspaceId],
          organizationId,
          userId,
        );
        const organizationGrant = {
          type: "organization",
          organizationId,
        } as const;
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
                user: {
                  email: `${userId}@example.test`,
                  emailVerified: true,
                },
                grants: { [LEGAL_LISTS_FEATURE_ID]: [organizationGrant] },
              }),
            ],
          ]),
        });
        const body = {
          name: "The drawdown occurred on 5 July 2021.",
          listId,
          listItemType: LIST_ITEM_TYPE.FACT,
        };
        const invoke = async (key: string) =>
          await createTask.handler(
            createTestHandlerContext<Parameters<typeof createTask.handler>[0]>({
              scopedDb,
              safeDb: safeDbFromScoped(scopedDb),
              audit: auditRecorderDouble(),
              memberRole: sessionMemberRole("owner"),
              workspaceId,
              featureAccessSnapshot,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              body,
              params: { workspaceId },
              query: {},
              route: "/tasks/:workspaceId",
              set: { headers: {} },
              request: new Request(
                `https://example.test/v1/tasks/${workspaceId}`,
                { method: "PUT", headers: { "Idempotency-Key": key } },
              ),
            }),
          );
        const stored = async () =>
          await scopedDb(async (tx) => ({
            items: await tx
              .select({ total: count() })
              .from(entities)
              .where(eq(entities.workspaceId, workspaceId)),
            placements: await tx
              .select({ total: count() })
              .from(legalListItems)
              .where(eq(legalListItems.listId, listId)),
          }));

        const first = await invoke("add-fact-lost-response");
        if (first instanceof Response || !("entityId" in first)) {
          panic("The first create did not return the new item");
        }

        // The response was lost; the client retries with the same key.
        const replay = await invoke("add-fact-lost-response");
        if (!(replay instanceof Response)) {
          panic("The retry ran the create again instead of replaying");
        }
        expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
        expect(await replay.json()).toEqual({ entityId: first.entityId });
        const afterReplay = await stored();
        expect(afterReplay.items.at(0)?.total).toBe(1);
        expect(afterReplay.placements.at(0)?.total).toBe(1);

        // A new add of the same statement is a new intent with a new key.
        const second = await invoke("add-fact-second-intent");
        if (second instanceof Response || !("entityId" in second)) {
          panic("A new key did not create a new item");
        }
        expect(second.entityId).not.toBe(first.entityId);
        const afterSecond = await stored();
        expect(afterSecond.items.at(0)?.total).toBe(2);
        expect(afterSecond.placements.at(0)?.total).toBe(2);
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
});
