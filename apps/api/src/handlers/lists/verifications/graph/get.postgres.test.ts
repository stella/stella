/**
 * The verification graph read on PostgreSQL, through the mounted handler:
 * a list's latest finished run per document, each claim as its reviewers
 * see it with both records of a conflict, held and testimony facts, the
 * documents facts come from, pages that never split or repeat a claim, and
 * nothing of a list the caller's matter does not hold.
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalListItemSources,
  legalLists,
  legalListSourceDocuments,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import readVerificationGraph from "@/api/handlers/lists/verifications/graph/get";
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
const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type GraphAnswer = {
  statements: { id: string; name: string; claimCount: number }[];
  claims: { id: string; statementId: string; state: string; text: string }[];
  facts: { id: string; held: boolean; tier: string; listed: boolean }[];
  sources: { id: string; name: string }[];
  citations: { type: string; claimId: string; factId: string }[];
  provenance: { factId: string; sourceId: string; locator: unknown }[];
  nextCursor: string | null;
};

const isGraphAnswer = (value: unknown): value is GraphAnswer =>
  typeof value === "object" &&
  value !== null &&
  "statements" in value &&
  "citations" in value;

if (!databaseUrl || !runPostgres) {
  describe.skip("verification graph read on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("the graph reads each document's latest run, links every citation once and refuses another matter's list", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const otherWorkspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const otherListId = createSafeId<"legalList">();
      const foreignListId = createSafeId<"legalList">();
      const ledgerId = createSafeId<"entity">();
      const ledgerVersionId = createSafeId<"entityVersion">();
      const interviewId = createSafeId<"entity">();
      const interviewVersionId = createSafeId<"entityVersion">();
      const statementId = createSafeId<"entity">();
      const defenceId = createSafeId<"entity">();
      const recordedFactId = createSafeId<"entity">();
      const recalledFactId = createSafeId<"entity">();
      const heldFactId = createSafeId<"entity">();
      const latestRunId = createSafeId<"legalListVerificationRun">();
      const olderRunId = createSafeId<"legalListVerificationRun">();
      const otherListRunId = createSafeId<"legalListVerificationRun">();
      const defenceRunId = createSafeId<"legalListVerificationRun">();
      const fileFieldId = toSafeId<"field">(Bun.randomUUIDv7());
      const supportedClaimId = createSafeId<"legalListClaim">();
      const conflictClaimId = createSafeId<"legalListClaim">();
      const gapClaimId = createSafeId<"legalListClaim">();
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
          name: "Graph fixture",
          slug: organizationId,
          createdAt: new Date("2026-11-01T09:00:00Z"),
        });
        await db.insert(user).values({
          id: userId,
          name: "Graph reader",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date("2026-11-01T09:00:00Z"),
        });
        await db.insert(workspaces).values([
          {
            id: workspaceId,
            organizationId,
            name: "Graph matter",
            reference: Bun.randomUUIDv7(),
          },
          {
            id: otherWorkspaceId,
            organizationId,
            name: "Walled matter",
            reference: Bun.randomUUIDv7(),
          },
        ]);
        await db.insert(legalLists).values([
          { id: listId, workspaceId, name: "Chronology", createdBy: userId },
          {
            id: otherListId,
            workspaceId,
            name: "Another list",
            createdBy: userId,
          },
          {
            id: foreignListId,
            workspaceId: otherWorkspaceId,
            name: "Walled list",
            createdBy: userId,
          },
        ]);
        const facts = [
          { id: recordedFactId, name: "Ledger records the payment on 23 Aug" },
          { id: recalledFactId, name: "Officer recalls the payment on 30 Aug" },
          { id: heldFactId, name: "Handwritten note, meaning unclear" },
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
            { id: defenceId, name: "Defence.pdf" },
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
        await db.insert(legalListFactDetails).values({
          itemEntityId: heldFactId,
          workspaceId,
          listId,
          scoring: "held",
          updatedBy: userId,
        });
        const source = ({
          itemEntityId,
          sourceEntityId,
          sourceEntityVersionId,
          pageNumber,
        }: {
          itemEntityId: SafeId<"entity">;
          sourceEntityId: SafeId<"entity">;
          sourceEntityVersionId: SafeId<"entityVersion">;
          pageNumber: number;
        }) => ({
          id: createSafeId<"legalListItemSource">(),
          workspaceId,
          listId,
          itemEntityId,
          sourceEntityId,
          sourceEntityVersionId,
          locator: { type: "pdf-page" as const, pageNumber },
          quote: null,
          createdBy: userId,
        });
        await db.insert(legalListItemSources).values([
          source({
            itemEntityId: recordedFactId,
            sourceEntityId: ledgerId,
            sourceEntityVersionId: ledgerVersionId,
            pageNumber: 14,
          }),
          source({
            itemEntityId: recalledFactId,
            sourceEntityId: interviewId,
            sourceEntityVersionId: interviewVersionId,
            pageNumber: 2,
          }),
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
        const evidence = (forList: SafeId<"legalList">) => ({
          listId: forList,
          facts: facts.map(({ id, name }) => pinned(id, name)),
        });
        const run = ({
          id,
          entityId,
          forList,
          createdAt,
        }: {
          id: SafeId<"legalListVerificationRun">;
          entityId: SafeId<"entity">;
          forList: SafeId<"legalList">;
          createdAt: string;
        }) => ({
          id,
          organizationId,
          workspaceId,
          entityId,
          fileFieldId,
          entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
          contentSha256: "d".repeat(64),
          evidence: evidence(forList),
          status: "completed" as const,
          errorCode: null,
          createdAt: new Date(createdAt),
        });
        await db.insert(legalListVerificationRuns).values([
          run({
            id: olderRunId,
            entityId: statementId,
            forList: listId,
            createdAt: "2026-11-01T10:00:00Z",
          }),
          run({
            id: latestRunId,
            entityId: statementId,
            forList: listId,
            createdAt: "2026-11-02T10:00:00Z",
          }),
          run({
            id: otherListRunId,
            entityId: statementId,
            forList: otherListId,
            createdAt: "2026-11-03T10:00:00Z",
          }),
          run({
            id: defenceRunId,
            entityId: defenceId,
            forList: listId,
            createdAt: "2026-11-02T11:00:00Z",
          }),
        ]);
        const anchor = {
          type: "docx-block",
          blockId: "p1",
          start: 0,
          end: 10,
        } as const;
        await createScopedDb(
          db,
          [workspaceId],
          organizationId,
          userId,
        )(async (tx) => {
          await tx.insert(legalListClaims).values([
            {
              id: supportedClaimId,
              workspaceId,
              runId: latestRunId,
              position: 0,
              type: "fact",
              text: "The ledger shows the payment.",
              anchor,
              state: "supported",
              score: 90,
              refs: [{ factEntityId: recordedFactId, rel: "supports" }],
            },
            {
              id: conflictClaimId,
              workspaceId,
              runId: latestRunId,
              position: 1,
              type: "fact",
              text: "The payment was made on 23 August.",
              anchor,
              state: "recordconflict",
              score: null,
              refs: [{ factEntityId: recalledFactId, rel: "conflicts" }],
              recordConflict: {
                subject: "The payment date",
                factEntityIds: [recalledFactId, recordedFactId],
                values: ["2021-08-30", "2021-08-23"],
                governingStates: ["contradicted", "supported"],
              },
            },
            {
              id: gapClaimId,
              workspaceId,
              runId: latestRunId,
              position: 2,
              type: "fact",
              text: "The witness never saw the ledger.",
              anchor,
              state: "contradicted",
              score: 10,
              refs: [{ factEntityId: heldFactId, rel: "conflicts" }],
            },
            // The superseded run's claim never shows.
            {
              id: createSafeId<"legalListClaim">(),
              workspaceId,
              runId: olderRunId,
              position: 0,
              type: "fact",
              text: "An earlier reading.",
              anchor,
              state: "nocover",
              score: null,
            },
            // A run against another list never shows.
            {
              id: createSafeId<"legalListClaim">(),
              workspaceId,
              runId: otherListRunId,
              position: 0,
              type: "fact",
              text: "Checked against another list.",
              anchor,
              state: "nocover",
              score: null,
            },
          ]);
          // The reviewer governs the conflict with the account.
          await tx.insert(legalListClaimReviewEvents).values({
            id: createSafeId<"legalListClaimReviewEvent">(),
            workspaceId,
            runId: latestRunId,
            claimId: conflictClaimId,
            kind: "record-conflict",
            payload: {
              kind: "record-conflict",
              resolution: { kind: "governed", factEntityId: recalledFactId },
              reason: "The witness saw the transfer.",
            },
            actorId: userId,
          });
        });

        const audited: string[] = [];
        const read = async (
          query: {
            listId: SafeId<"legalList">;
            cursor?: string;
            limit?: number;
          },
          scope: SafeId<"workspace"> = workspaceId,
        ) =>
          await readVerificationGraph.handler(
            createTestHandlerContext<
              Parameters<typeof readVerificationGraph.handler>[0]
            >({
              audit: auditRecorderDouble((events) => {
                for (const event of events) {
                  const runId = event.metadata?.["runId"];
                  if (typeof runId === "string") {
                    audited.push(runId);
                  }
                }
              }),
              scopedDb: NO_DB,
              workspaceId: scope,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb: createSafeDb(db, [scope], organizationId, userId),
              query,
            }),
          );

        const answer = await read({ listId });
        if (!isGraphAnswer(answer)) {
          throw new Error(`Expected a graph, got ${JSON.stringify(answer)}`);
        }
        // One statement per document: the latest finished run on this list.
        expect(answer.statements.map(({ id }) => id).toSorted()).toEqual(
          [latestRunId, defenceRunId].toSorted(),
        );
        expect(
          answer.statements.find(({ id }) => id === latestRunId),
        ).toMatchObject({ name: "Witness statement.docx", claimCount: 3 });
        expect(answer.claims.map(({ id }) => id)).toEqual([
          supportedClaimId,
          conflictClaimId,
          gapClaimId,
        ]);
        // The governed conflict reads with the governing record's verdict.
        expect(
          answer.claims.find(({ id }) => id === conflictClaimId)?.state,
        ).toBe("contradicted");
        // Both records of the conflict, and the citation of one of them is
        // the same edge, never a second one.
        const conflictEdges = answer.citations.filter(
          ({ claimId }) => claimId === conflictClaimId,
        );
        expect(conflictEdges).toHaveLength(2);
        expect(
          conflictEdges.every(({ type }) => type === "record-conflict"),
        ).toBe(true);
        expect(answer.citations).toHaveLength(4);
        expect(answer.facts.find(({ id }) => id === heldFactId)).toMatchObject({
          held: true,
          listed: true,
        });
        expect(answer.facts.find(({ id }) => id === recalledFactId)?.tier).toBe(
          "testimony",
        );
        expect(answer.sources.map(({ name }) => name).toSorted()).toEqual([
          "Interview note.docx",
          "Ledger export.pdf",
        ]);
        expect(
          answer.provenance.find(({ factId }) => factId === recordedFactId),
        ).toMatchObject({
          sourceId: ledgerId,
          locator: { type: "pdf-page", pageNumber: 14 },
        });
        expect(answer.nextCursor).toBeNull();

        // Pages of one claim neither split nor repeat any claim.
        const paged: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          // db-await-in-loop: walks the cursor pages of a four-claim fixture, one read per page.
          const next = await read({
            listId,
            limit: 1,
            ...(cursor === undefined ? {} : { cursor }),
          });
          if (!isGraphAnswer(next)) {
            throw new Error("Expected a graph page");
          }
          paged.push(...next.claims.map(({ id }) => id));
          if (next.nextCursor === null) {
            break;
          }
          cursor = next.nextCursor;
        }
        expect(paged).toEqual(answer.claims.map(({ id }) => id));

        // The first read of the day delivered both runs, so it audited each;
        // the pages after it audit nothing again.
        expect(audited.toSorted()).toEqual(
          [latestRunId, defenceRunId].toSorted(),
        );

        // A list of a matter outside the caller's scope reads as absent,
        // and so does an id no list has.
        for (const [scopeList, scope] of [
          [foreignListId, workspaceId],
          [createSafeId<"legalList">(), workspaceId],
        ] as const) {
          // db-await-in-loop: two refusal cases, one read each.
          const refused = await read({ listId: scopeList }, scope);
          expect(refused).toMatchObject({ code: 404 });
        }
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
