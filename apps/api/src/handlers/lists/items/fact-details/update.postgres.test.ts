import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { MATTER_VISIBILITY } from "@stll/api-contract";
import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  legalListFactDetails,
  legalListItems,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import updateFactDetails from "@/api/handlers/lists/items/fact-details/update";
import readListItems from "@/api/handlers/lists/items/list";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
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

const testState = createTestState({ file: import.meta.path, config: env });
const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("fact detail nullable confidence on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("first writes, replay, and reinclude preserve null confidence", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const heldItemId = createSafeId<"entity">();
      const notedItemId = createSafeId<"entity">();
      testState.setConfig("FEATURE_LEGAL_LISTS", true);
      testState.setConfig(
        "API_FEATURE_ACCESS_GRANTS",
        organizationFeatureGrants(organizationId, [
          LEGAL_LISTS_FEATURE_ID,
          LIST_VERIFICATION_FEATURE_ID,
        ]),
      );

      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Fact detail fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Fact detail user",
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
          visibility: MATTER_VISIBILITY.adminsAndAssigned,
          id: workspaceId,
          organizationId,
          name: "Fact detail matter",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(legalLists).values({
          id: listId,
          workspaceId,
          name: "Fact detail list",
          createdBy: userId,
        });
        const itemValues = [
          { id: heldItemId, name: "Held fact", position: "a" },
          { id: notedItemId, name: "Noted fact", position: "b" },
        ];
        await db.insert(entities).values(
          itemValues.map(({ id, name }) => ({
            id,
            workspaceId,
            kind: "task" as const,
            listItemType: LIST_ITEM_TYPE.FACT,
            name,
            createdBy: userId,
            agendaKind: "task" as const,
            status: "open" as const,
            priority: "none" as const,
            agendaSource: "manual" as const,
          })),
        );
        await db.insert(legalListItems).values(
          itemValues.map(({ id, position }) => ({
            entityId: id,
            workspaceId,
            listId,
            position,
            addedBy: userId,
          })),
        );

        const safeDb = createSafeDb(db, [workspaceId], organizationId, userId);
        const organizationGrant = {
          type: "organization",
          organizationId,
        } as const;
        const featureAccessSnapshot = createFeatureAccessSnapshot({
          organizationId,
          userId,
          decisions: new Map(
            [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID].map(
              (featureId) => [
                featureId,
                decideFeatureAccess({
                  registry: FEATURE_REGISTRY,
                  featureId,
                  organizationId,
                  userId,
                  membership: true,
                  user: {
                    email: `${userId}@example.test`,
                    emailVerified: true,
                  },
                  grants: {
                    [LEGAL_LISTS_FEATURE_ID]: [organizationGrant],
                    [LIST_VERIFICATION_FEATURE_ID]: [organizationGrant],
                  },
                }),
              ],
            ),
          ),
        });
        const readDetails = async () => {
          const result = await readListItems.handler(
            createTestHandlerContext<
              Parameters<typeof readListItems.handler>[0]
            >({
              audit: auditRecorderDouble(),
              scopedDb: NO_DB,
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              featureAccessSnapshot,
              params: { workspaceId, listId },
              query: {},
            }),
          );
          if (!("items" in result)) {
            throw new Error(
              `expected list page, got ${JSON.stringify(result)}`,
            );
          }
          return new Map(
            result.items.map(({ id, factDetails }) => [id, factDetails]),
          );
        };
        type SaveOptions = {
          itemEntityId: typeof heldItemId;
          scoring: "held" | "included";
          interpretationNote: string | null;
        };
        const save = async ({
          itemEntityId,
          scoring,
          interpretationNote,
        }: SaveOptions) => {
          const body = {
            listId,
            itemEntityId,
            occurredOn: null,
            evidenceKind: null,
            medium: null,
            confidence: null,
            interpretationNote,
            scoring,
          };
          expect(v.is(updateFactDetails.config.body, body)).toBe(true);
          return await updateFactDetails.handler(
            createTestHandlerContext<
              Parameters<typeof updateFactDetails.handler>[0]
            >({
              audit: auditRecorderDouble(),
              scopedDb: NO_DB,
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              body,
            }),
          );
        };
        expect(await readDetails()).toEqual(
          new Map([
            [heldItemId, null],
            [notedItemId, null],
          ]),
        );

        const heldWrite = await save({
          itemEntityId: heldItemId,
          scoring: "held",
          interpretationNote: null,
        });
        expect(heldWrite).toEqual({
          itemEntityId: heldItemId,
          occurredOn: null,
          occurredOnPrecision: null,
          evidenceKind: null,
          medium: null,
          confidence: null,
          interpretationNote: null,
          scoring: "held",
        });
        const note = "This event still needs corroboration.";
        const notedWrite = await save({
          itemEntityId: notedItemId,
          scoring: "included",
          interpretationNote: note,
        });
        expect(notedWrite).toMatchObject({
          itemEntityId: notedItemId,
          confidence: null,
          interpretationNote: note,
          scoring: "included",
        });

        expect(await readDetails()).toEqual(
          new Map([
            [
              heldItemId,
              {
                confidence: null,
                occurredOn: null,
                occurredOnPrecision: null,
                evidenceKind: null,
                medium: null,
                interpretationNote: null,
                scoring: "held",
              },
            ],
            [
              notedItemId,
              {
                confidence: null,
                occurredOn: null,
                occurredOnPrecision: null,
                evidenceKind: null,
                medium: null,
                interpretationNote: note,
                scoring: "included",
              },
            ],
          ]),
        );

        expect(
          await save({
            itemEntityId: heldItemId,
            scoring: "held",
            interpretationNote: null,
          }),
        ).toMatchObject({
          confidence: null,
          scoring: "held",
        });
        expect(
          await save({
            itemEntityId: heldItemId,
            scoring: "included",
            interpretationNote: null,
          }),
        ).toMatchObject({
          confidence: null,
          scoring: "included",
        });
        const listedAfterReplay = await readDetails();
        expect(listedAfterReplay.get(heldItemId)).toMatchObject({
          confidence: null,
          interpretationNote: null,
          scoring: "included",
        });
        expect(listedAfterReplay.get(notedItemId)).toMatchObject({
          confidence: null,
          interpretationNote: note,
          scoring: "included",
        });
        const persisted = await db
          .select({
            confidence: legalListFactDetails.confidence,
            interpretationNote: legalListFactDetails.interpretationNote,
            scoring: legalListFactDetails.scoring,
          })
          .from(legalListFactDetails)
          .where(eq(legalListFactDetails.itemEntityId, heldItemId));
        expect(persisted).toEqual([
          { confidence: null, interpretationNote: null, scoring: "included" },
        ]);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
