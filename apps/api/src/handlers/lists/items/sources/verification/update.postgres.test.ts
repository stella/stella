import { describe, expect, test } from "bun:test";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import type { ReviewDecision } from "@stll/api-contract/review-decision";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { OnlineMigrationConnection } from "@/api/db/online-migration-connection";
import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import {
  entities,
  entityVersions,
  legalListItems,
  legalListItemSourceDecisions,
  legalListItemSources,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import verifyItemSource from "@/api/handlers/lists/items/sources/verification/update";
import { createSafeId } from "@/api/lib/branded-types";
import { AGGREGATE_TRANSACTION_BUDGETS as BUDGETS } from "@/api/lib/db/aggregate-transaction-budget";
import {
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

import { LEGAL_LIST_SOURCE_DECISION_BACKFILL } from "../../../../../db/legal-list-source-decision-backfill";

const testState = createTestState({ file: import.meta.path, config: env });
const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const DECIDED_BEFORE_HISTORY = new Date("2026-01-01T00:00:00Z");

if (!databaseUrl || !runPostgres) {
  describe.skip("list source decision history on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("the handler and the backfill write one baseline, history is append-only, workspace-bound and feature-gated", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client, db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const otherWorkspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const otherListId = createSafeId<"legalList">();
      const factId = createSafeId<"entity">();
      const otherFactId = createSafeId<"entity">();
      const documentId = createSafeId<"entity">();
      const otherDocumentId = createSafeId<"entity">();
      const versionId = createSafeId<"entityVersion">();
      const otherVersionId = createSafeId<"entityVersion">();
      // Decided before history began, then changed through the handler.
      const changedSourceId = createSafeId<"legalListItemSource">();
      // Never decided, then accepted through the handler.
      const freshSourceId = createSafeId<"legalListItemSource">();
      // Decided before history began and never touched: the backfill's.
      const untouchedSourceId = createSafeId<"legalListItemSource">();
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
          name: "Source history fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Šárka Dvořáková",
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
        await db.insert(workspaces).values(
          [workspaceId, otherWorkspaceId].map((id) => ({
            id,
            organizationId,
            name: "Source history matter",
            reference: Bun.randomUUIDv7(),
          })),
        );
        await db.insert(legalLists).values([
          { id: listId, workspaceId, name: "Facts", createdBy: userId },
          {
            id: otherListId,
            workspaceId: otherWorkspaceId,
            name: "Facts",
            createdBy: userId,
          },
        ]);
        const fact = {
          createdBy: userId,
          kind: "task" as const,
          listItemType: LIST_ITEM_TYPE.FACT,
          agendaKind: "task" as const,
          status: "open" as const,
          priority: "none" as const,
          agendaSource: "manual" as const,
        };
        await db.insert(entities).values([
          {
            ...fact,
            id: factId,
            workspaceId,
            name: "Smlouva podepsána",
          },
          {
            ...fact,
            id: otherFactId,
            workspaceId: otherWorkspaceId,
            name: "Výpověď doručena",
          },
          {
            id: documentId,
            workspaceId,
            kind: "document",
            name: "Zápis z jednání.docx",
            createdBy: userId,
          },
          {
            id: otherDocumentId,
            workspaceId: otherWorkspaceId,
            kind: "document",
            name: "E-mail.pdf",
            createdBy: userId,
          },
        ]);
        await db.insert(entityVersions).values([
          { id: versionId, workspaceId, entityId: documentId },
          {
            id: otherVersionId,
            workspaceId: otherWorkspaceId,
            entityId: otherDocumentId,
          },
        ]);
        await db.insert(legalListItems).values([
          {
            entityId: factId,
            workspaceId,
            listId,
            position: "a",
            addedBy: userId,
          },
          {
            entityId: otherFactId,
            workspaceId: otherWorkspaceId,
            listId: otherListId,
            position: "a",
            addedBy: userId,
          },
        ]);
        const source = {
          sourceEntityId: documentId,
          sourceEntityVersionId: versionId,
          locator: { type: "docx-block", blockId: "p4" },
        } as const;
        await db.insert(legalListItemSources).values([
          {
            ...source,
            id: changedSourceId,
            workspaceId,
            listId,
            itemEntityId: factId,
            verificationStatus: "verified",
            verifiedBy: userId,
            verifiedAt: DECIDED_BEFORE_HISTORY,
          },
          {
            ...source,
            id: freshSourceId,
            workspaceId,
            listId,
            itemEntityId: factId,
          },
          {
            id: untouchedSourceId,
            workspaceId: otherWorkspaceId,
            listId: otherListId,
            itemEntityId: otherFactId,
            sourceEntityId: otherDocumentId,
            sourceEntityVersionId: otherVersionId,
            locator: { type: "pdf-page", pageNumber: 2 },
            verificationStatus: "rejected",
            verifiedBy: userId,
            verifiedAt: DECIDED_BEFORE_HISTORY,
          },
        ]);

        const safeDb = createSafeDb(db, {
          budget: BUDGETS.scopedRequest,
          workspaceIds: [workspaceId],
          organizationId,
          userId,
        });
        const verify = async (
          id: typeof changedSourceId,
          status: "verified" | "rejected" | "unverified",
        ) =>
          await verifyItemSource.handler(
            createTestHandlerContext<
              Parameters<typeof verifyItemSource.handler>[0]
            >({
              audit: auditRecorderDouble(),
              scopedDb: NO_DB,
              workspaceId,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              body: { id, listId, itemEntityId: factId, status },
            }),
          );
        const history = async () =>
          await db
            .select({
              // A baseline takes its source's id.
              baseline: sql<boolean>`${legalListItemSourceDecisions.id} = ${legalListItemSourceDecisions.sourceId}`,
              sourceId: legalListItemSourceDecisions.sourceId,
              decision: legalListItemSourceDecisions.decision,
              actorId: legalListItemSourceDecisions.actorId,
              createdAt: legalListItemSourceDecisions.createdAt,
              gate: legalListItemSourceDecisions.entityFeatureGate,
            })
            .from(legalListItemSourceDecisions)
            .where(
              inArray(legalListItemSourceDecisions.sourceId, [
                changedSourceId,
                freshSourceId,
                untouchedSourceId,
              ]),
            )
            .orderBy(
              asc(legalListItemSourceDecisions.sourceId),
              asc(legalListItemSourceDecisions.createdAt),
              asc(legalListItemSourceDecisions.id),
            );

        // A change to a source decided before history began writes that
        // earlier decision first, under the source's own id.
        expect(await verify(changedSourceId, "rejected")).toEqual({
          id: changedSourceId,
        });
        // A restatement restamps who and when, so it joins the history too.
        expect(await verify(changedSourceId, "rejected")).toEqual({
          id: changedSourceId,
        });
        expect(await verify(freshSourceId, "verified")).toEqual({
          id: freshSourceId,
        });
        expect(await verify(freshSourceId, "unverified")).toEqual({
          id: freshSourceId,
        });

        const handled = await history();
        const event = (
          sourceId: typeof changedSourceId,
          decision: ReviewDecision | null,
          baseline = false,
        ) => ({
          baseline,
          sourceId,
          decision,
          actorId: userId,
          gate: "legal-lists" as const,
        });
        const changedEvents = [
          event(changedSourceId, "accepted", true),
          event(changedSourceId, "rejected"),
          event(changedSourceId, "rejected"),
        ];
        const freshEvents = [
          event(freshSourceId, "accepted"),
          event(freshSourceId, null),
        ];
        // Ordered as the query orders them: by source id, then time.
        expect(handled.map(({ createdAt: _createdAt, ...row }) => row)).toEqual(
          changedSourceId < freshSourceId
            ? [...changedEvents, ...freshEvents]
            : [...freshEvents, ...changedEvents],
        );
        expect(handled.find(({ baseline }) => baseline)?.createdAt).toEqual(
          DECIDED_BEFORE_HISTORY,
        );

        // The backfill gives the untouched source its baseline under the same
        // key and leaves sources with history alone, once.
        const connection: OnlineMigrationConnection = {
          query: async (statement, parameters = []) =>
            await client.unsafe<unknown[]>(statement, [...parameters]),
          execute: async (statement, parameters = []) => {
            await client.unsafe(statement, [...parameters]);
          },
          release: () => {},
        };
        const repair = LEGAL_LIST_SOURCE_DECISION_BACKFILL;
        expect(await repair.readCompletion(connection)).toMatchObject({
          type: "incomplete",
        });
        expect(await repair.repair(connection)).toEqual({ type: "complete" });
        expect(await repair.readCompletion(connection)).toEqual({
          type: "complete",
        });
        expect(await repair.repair(connection)).toEqual({ type: "complete" });
        const backfilled = await history();
        expect(backfilled).toHaveLength(handled.length + 1);
        expect(
          backfilled.filter(({ sourceId }) => sourceId === untouchedSourceId),
        ).toEqual([
          {
            baseline: true,
            sourceId: untouchedSourceId,
            decision: "rejected",
            actorId: userId,
            createdAt: DECIDED_BEFORE_HISTORY,
            gate: LEGAL_LISTS_FEATURE_ID,
          },
        ]);

        // As the application role: rows follow workspace and feature, a
        // visible workspace cannot write another workspace's source history,
        // and nothing is ever changed or removed.
        const asApplication = async <T>(
          features: readonly string[],
          work: (tx: typeof client) => Promise<T>,
        ) =>
          await client.begin(async (tx) => {
            await tx`SELECT set_config('role', 'stella', true),
              set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true),
              set_config(${SETTING_USER_ID}, ${userId}, true),
              set_config(${SETTING_WORKSPACE_IDS}, ${`{${workspaceId}}`}, true),
              set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
              set_config('app.enabled_features', ${JSON.stringify(features)}, true)`;
            return await work(tx);
          });
        const visibleSources = async (features: readonly string[]) =>
          await asApplication(features, async (tx) =>
            [
              ...(await tx<{ sourceId: string }[]>`
                SELECT DISTINCT source_id::text AS "sourceId"
                FROM legal_list_item_source_decisions
                WHERE source_id IN (${changedSourceId}, ${freshSourceId}, ${untouchedSourceId})`),
            ]
              .map(({ sourceId }) => sourceId)
              .toSorted(),
          );
        expect(await visibleSources([])).toEqual([]);
        expect(await visibleSources([LEGAL_LISTS_FEATURE_ID])).toEqual(
          [changedSourceId, freshSourceId].toSorted(),
        );
        expect(
          await rejectionOf(
            asApplication([LEGAL_LISTS_FEATURE_ID], async (tx) => {
              await tx`INSERT INTO legal_list_item_source_decisions
                (id, workspace_id, source_id, decision, actor_id)
                VALUES (${Bun.randomUUIDv7()}, ${workspaceId}, ${untouchedSourceId},
                  'accepted', ${userId})`;
            }),
          ),
        ).toMatchObject({
          message: expect.stringMatching(/row-level security/u),
        });
        for (const statement of [
          `UPDATE legal_list_item_source_decisions SET reason = 'changed'`,
          `DELETE FROM legal_list_item_source_decisions`,
        ]) {
          expect(
            await rejectionOf(
              asApplication([LEGAL_LISTS_FEATURE_ID], async (tx) => {
                await tx.unsafe(statement);
              }),
            ),
          ).toMatchObject({
            message: expect.stringMatching(/permission denied/u),
          });
        }
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
