/**
 * A record-conflict review event keeps the record that was suggested to
 * govern when the reviewer acted, beside the record they chose, so history
 * can tell a confirmed suggestion from another choice.
 */

import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListItems,
  legalListItemSources,
  legalLists,
  legalListSourceDocuments,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import createClaimReview from "@/api/handlers/lists/verifications/claim-reviews/create";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import type { VerificationEvidenceFact } from "@/api/lib/lists/verification/contract";
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
  describe.skip("record-conflict review events on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("a record-conflict event stores the suggested record beside the chosen one", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const runId = createSafeId<"legalListVerificationRun">();
      const claimId = createSafeId<"legalListClaim">();
      const ledgerId = createSafeId<"entity">();
      const ledgerVersionId = createSafeId<"entityVersion">();
      const interviewId = createSafeId<"entity">();
      const interviewVersionId = createSafeId<"entityVersion">();
      const statementId = createSafeId<"entity">();
      /** Recorded by the ledger: a document's record. */
      const recordedFactId = createSafeId<"entity">();
      /** Recalled in an interview marked as testimony. */
      const recalledFactId = createSafeId<"entity">();
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
          name: "Conflict review fixture",
          slug: organizationId,
          createdAt: new Date(clock.now()),
        });
        await db.insert(user).values({
          id: userId,
          name: "Conflict reviewer",
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
          name: "Conflict review matter",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(legalLists).values({
          id: listId,
          workspaceId,
          name: "Chronology",
          createdBy: userId,
        });
        const facts = [
          { id: recordedFactId, name: "Ledger records the payment on 23 Aug" },
          { id: recalledFactId, name: "Officer recalls the payment on 30 Aug" },
        ];
        await db.insert(entities).values([
          ...facts.map(({ id, name }) => ({
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
          ...[
            { id: ledgerId, name: "Ledger export.pdf" },
            { id: interviewId, name: "Interview note.docx" },
            { id: statementId, name: "Witness statement.docx" },
          ].map(({ id, name }) => ({
            id,
            workspaceId,
            kind: "document" as const,
            name,
            createdBy: userId,
          })),
        ]);
        await db.insert(entityVersions).values([
          { id: ledgerVersionId, workspaceId, entityId: ledgerId },
          { id: interviewVersionId, workspaceId, entityId: interviewId },
        ]);
        await db.insert(legalListItems).values(
          facts.map(({ id }, index) => ({
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
            source(recordedFactId, ledgerId, ledgerVersionId),
            source(recalledFactId, interviewId, interviewVersionId),
          ]);
        await db.insert(legalListSourceDocuments).values({
          workspaceId,
          listId,
          documentEntityId: interviewId,
          sourceKind: "testimony",
          updatedBy: userId,
        });
        const pinned = (
          factEntityId: SafeId<"entity">,
          text: string,
        ): VerificationEvidenceFact => ({
          factEntityId,
          text,
          occurredOn: null,
          occurredOnPrecision: null,
          evidenceKind: null,
          medium: null,
          confidence: "high",
          interpretationNote: null,
          sources: [],
        });
        await db.insert(legalListVerificationRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          entityId: statementId,
          fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
          entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
          contentSha256: "d".repeat(64),
          evidence: {
            listId,
            facts: facts.map(({ id, name }) => pinned(id, name)),
          },
          status: "completed",
        });
        // Claims carry the organization gate, so they are written as a
        // member of the matter, as the engine writes them.
        await createScopedDb(
          db,
          [workspaceId],
          organizationId,
          userId,
        )(
          async (tx) =>
            await tx.insert(legalListClaims).values({
              id: claimId,
              workspaceId,
              runId,
              position: 0,
              type: "fact",
              text: "The payment was made on 23 August.",
              anchor: { type: "docx-block", blockId: "p1", start: 0, end: 10 },
              state: "recordconflict",
              score: null,
              refs: [],
              // The account is listed first, so the suggestion is not simply
              // the first record.
              recordConflict: {
                subject: "The payment date",
                factEntityIds: [recalledFactId, recordedFactId],
                values: ["2021-08-30", "2021-08-23"],
                governingStates: ["contradicted", "supported"],
              },
            }),
        );

        const safeDb = createSafeDb(db, [workspaceId], organizationId, userId);
        const record = async (
          event: v.InferInput<typeof createClaimReview.config.body>["event"],
        ) => {
          const body = { runId, claimId, event };
          expect(v.is(createClaimReview.config.body, body)).toBe(true);
          return await createClaimReview.handler(
            createTestHandlerContext<
              Parameters<typeof createClaimReview.handler>[0]
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

        // The reviewer picks the account over the suggested record.
        expect(
          await record({
            kind: "record-conflict",
            resolution: { kind: "governed", factEntityId: recalledFactId },
          }),
        ).toMatchObject({
          claimId,
          review: {
            recordConflictResolution: {
              kind: "governed",
              factEntityId: recalledFactId,
            },
          },
        });
        await record({ kind: "note", note: "The ledger was corrected later." });

        const events = await createScopedDb(
          db,
          [workspaceId],
          organizationId,
          userId,
        )(
          async (tx) =>
            await tx
              .select({ payload: legalListClaimReviewEvents.payload })
              .from(legalListClaimReviewEvents)
              .where(
                and(
                  eq(legalListClaimReviewEvents.workspaceId, workspaceId),
                  eq(legalListClaimReviewEvents.claimId, claimId),
                ),
              )
              .orderBy(legalListClaimReviewEvents.createdAt),
        );
        expect(events.map(({ payload }) => payload)).toEqual([
          {
            kind: "record-conflict",
            resolution: { kind: "governed", factEntityId: recalledFactId },
            suggestedFactEntityId: recordedFactId,
          },
          // Only a record-conflict event carries a suggestion.
          { kind: "note", note: "The ledger was corrected later." },
        ]);
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
