/**
 * A document's kind on a list, end to end on PostgreSQL: set through the
 * handler, read back for every named document, inherited by every fact
 * citing the document in the list read, and held to the closed kinds and
 * the list's lifetime by the table itself.
 */

import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  legalListItems,
  legalListItemSources,
  legalLists,
  legalListSourceDocuments,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import readListItems from "@/api/handlers/lists/items/list";
import readSourceDocumentKinds from "@/api/handlers/lists/source-documents/list";
import updateSourceDocumentKind from "@/api/handlers/lists/source-documents/update";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import type { SourceKind } from "@/api/lib/lists/source-kind";
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
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

const testState = createTestState({ file: import.meta.path, config: env });
const clock = createTestClock();
const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("list source document kinds on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("a document marked as testimony moves every fact citing it, and the table keeps kinds closed", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const statementId = createSafeId<"entity">();
      const statementVersionId = createSafeId<"entityVersion">();
      const minutesId = createSafeId<"entity">();
      const minutesVersionId = createSafeId<"entityVersion">();
      const toldFactId = createSafeId<"entity">();
      const recordedFactId = createSafeId<"entity">();
      const bareFactId = createSafeId<"entity">();
      const taskId = createSafeId<"entity">();
      const strangerId = createSafeId<"entity">();
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
          name: "Source kind fixture",
          slug: organizationId,
          createdAt: new Date(clock.now()),
        });
        await db.insert(user).values({
          id: userId,
          name: "Source kind reviewer",
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
          name: "Source kind matter",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(legalLists).values({
          id: listId,
          workspaceId,
          name: "Chronology",
          createdBy: userId,
        });
        const items = [
          { id: toldFactId, name: "The ward was told on 3 May", type: "fact" },
          { id: recordedFactId, name: "Minutes record 3 May", type: "fact" },
          { id: bareFactId, name: "Recollection of a call", type: "fact" },
          { id: taskId, name: "Request the ward rota", type: "task" },
        ] as const;
        await db.insert(entities).values([
          ...items.map(({ id, name, type }) => ({
            id,
            workspaceId,
            kind: "task" as const,
            listItemType:
              type === "fact" ? LIST_ITEM_TYPE.FACT : LIST_ITEM_TYPE.TASK,
            name,
            createdBy: userId,
            agendaKind: "task" as const,
            status: "open" as const,
            priority: "none" as const,
            agendaSource: "manual" as const,
          })),
          ...[
            { id: statementId, name: "Witness statement.docx" },
            { id: minutesId, name: "Board minutes.pdf" },
          ].map(({ id, name }) => ({
            id,
            workspaceId,
            kind: "document" as const,
            name,
            createdBy: userId,
          })),
        ]);
        await db.insert(entityVersions).values([
          { id: statementVersionId, workspaceId, entityId: statementId },
          { id: minutesVersionId, workspaceId, entityId: minutesId },
        ]);
        await db.insert(legalListItems).values(
          items.map(({ id }, index) => ({
            entityId: id,
            workspaceId,
            listId,
            position: String.fromCodePoint(97 + index),
            addedBy: userId,
          })),
        );
        const source = (
          itemEntityId: SafeId<"entity">,
          sourceEntityId: SafeId<"entity">,
          sourceEntityVersionId: SafeId<"entityVersion">,
        ) => ({
          id: createSafeId<"legalListItemSource">(),
          workspaceId,
          listId,
          itemEntityId,
          sourceEntityId,
          sourceEntityVersionId,
          locator: { type: "document" as const },
          quote: null,
          createdBy: userId,
        });
        await db
          .insert(legalListItemSources)
          .values([
            source(toldFactId, statementId, statementVersionId),
            source(recordedFactId, statementId, statementVersionId),
            source(recordedFactId, minutesId, minutesVersionId),
            source(taskId, statementId, statementVersionId),
          ]);

        const safeDb = createSafeDb(db, [workspaceId], organizationId, userId);
        const grant = { type: "organization", organizationId } as const;
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
                    [LEGAL_LISTS_FEATURE_ID]: [grant],
                    [LIST_VERIFICATION_FEATURE_ID]: [grant],
                  },
                }),
              ],
            ),
          ),
        });
        const context = {
          audit: auditRecorderDouble(),
          scopedDb: NO_DB,
          workspaceId,
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
          safeDb,
        };

        const readKinds = async (
          documentEntityIds: SafeId<"entity">[] = [statementId, minutesId],
        ) =>
          await readSourceDocumentKinds.handler(
            createTestHandlerContext<
              Parameters<typeof readSourceDocumentKinds.handler>[0]
            >({
              ...context,
              body: { listId, documentEntityIds },
            }),
          );
        const setKind = async (
          documentEntityId: SafeId<"entity">,
          sourceKind: SourceKind,
        ) => {
          const body = { listId, documentEntityId, sourceKind };
          expect(v.is(updateSourceDocumentKind.config.body, body)).toBe(true);
          return await updateSourceDocumentKind.handler(
            createTestHandlerContext<
              Parameters<typeof updateSourceDocumentKind.handler>[0]
            >({
              ...context,
              body,
            }),
          );
        };
        const readTiers = async () => {
          const result = await readListItems.handler(
            createTestHandlerContext<
              Parameters<typeof readListItems.handler>[0]
            >({
              ...context,
              featureAccessSnapshot,
              params: { workspaceId, listId },
              query: {},
            }),
          );
          if (!("items" in result)) {
            throw new Error(`expected a list page: ${JSON.stringify(result)}`);
          }
          return Object.fromEntries(
            result.items.map(({ id, sourceTier }) => [id, sourceTier]),
          );
        };

        // Nobody has classified either document: both are records.
        expect(await readKinds()).toEqual({
          documents: [
            { documentEntityId: statementId, sourceKind: "document" },
            { documentEntityId: minutesId, sourceKind: "document" },
          ],
        });
        expect(await readTiers()).toEqual({
          [toldFactId]: "document",
          [recordedFactId]: "document",
          [bareFactId]: "unsourced",
          // Only facts carry a tier.
          [taskId]: null,
        });

        expect(await setKind(statementId, "testimony")).toEqual({
          listId,
          documentEntityId: statementId,
          sourceKind: "testimony",
        });
        // Setting the kind a document already has changes nothing.
        expect(await setKind(statementId, "testimony")).toEqual({
          listId,
          documentEntityId: statementId,
          sourceKind: "testimony",
        });
        expect(await readKinds()).toEqual({
          documents: [
            { documentEntityId: statementId, sourceKind: "testimony" },
            { documentEntityId: minutesId, sourceKind: "document" },
          ],
        });
        expect(await readTiers()).toEqual({
          [toldFactId]: "testimony",
          // The minutes still record it, so one testimony source does not
          // lower it.
          [recordedFactId]: "document",
          [bareFactId]: "unsourced",
          [taskId]: null,
        });

        // Back to a record: the facts follow.
        await setKind(statementId, "document");
        expect((await readTiers())[toldFactId]).toBe("document");

        // A document the matter does not hold is refused, not defaulted.
        const unknown = await readKinds([strangerId]);
        expect(unknown).toMatchObject({ code: 404 });
        expect(await setKind(strangerId, "testimony")).toMatchObject({
          code: 404,
        });

        // The table holds only the closed kinds, one row per document per
        // list, and goes with its list.
        const insertKind = (kind: string) =>
          db
            .execute(
              sql`INSERT INTO ${legalListSourceDocuments} (workspace_id, list_id, document_entity_id, source_kind, entity_feature_gate) VALUES (${workspaceId}, ${listId}, ${minutesId}, ${kind}, 'open')`,
            )
            .then(
              () => "stored",
              () => "rejected",
            );
        expect(await insertKind("hearsay")).toBe("rejected");
        expect(await insertKind("testimony")).toBe("stored");
        expect(await insertKind("document")).toBe("rejected");
        await db.delete(legalLists).where(eq(legalLists.id, listId));
        expect(
          await db
            .select({ id: legalListSourceDocuments.documentEntityId })
            .from(legalListSourceDocuments)
            .where(eq(legalListSourceDocuments.listId, listId)),
        ).toEqual([]);
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
