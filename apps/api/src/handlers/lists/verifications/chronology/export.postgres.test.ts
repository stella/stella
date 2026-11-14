/**
 * The chronology export on PostgreSQL, through the mounted handler: a row
 * per fact on the list in the order it happened (a month-precision date
 * before a day in that month, undated facts last, whatever the list's
 * order), each with its first source and the claims citing it as reviewers
 * see them, as CSV and as a DOCX archive; and nothing of a list the caller's
 * matter does not hold.
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { ZipArchive } from "@stll/docx-core/zip";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalListItemSources,
  legalLists,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import exportVerificationChronology from "@/api/handlers/lists/verifications/chronology/export";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
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

if (!databaseUrl || !runPostgres) {
  describe.skip("verification chronology export on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("the export lists the facts in the order they happened, as CSV and DOCX, and refuses another matter's list", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const otherWorkspaceId = createSafeId<"workspace">();
      const listId = createSafeId<"legalList">();
      const foreignListId = createSafeId<"legalList">();
      const ledgerId = createSafeId<"entity">();
      const ledgerVersionId = createSafeId<"entityVersion">();
      const statementId = createSafeId<"entity">();
      const paymentFactId = createSafeId<"entity">();
      const noteFactId = createSafeId<"entity">();
      const agreementFactId = createSafeId<"entity">();
      const runId = createSafeId<"legalListVerificationRun">();
      const fileFieldId = toSafeId<"field">(Bun.randomUUIDv7());
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
          name: "Chronology fixture",
          slug: organizationId,
          createdAt: new Date("2026-11-01T09:00:00Z"),
        });
        await db.insert(user).values({
          id: userId,
          name: "Chronology reader",
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
            name: "Chronology matter",
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
            id: foreignListId,
            workspaceId: otherWorkspaceId,
            name: "Walled list",
            createdBy: userId,
          },
        ]);
        // The list's own order is not the order the facts happened in.
        const facts = [
          { id: paymentFactId, name: "Ledger records the payment on 23 Aug" },
          { id: noteFactId, name: "Handwritten note, undated" },
          { id: agreementFactId, name: "Agreement signed in August" },
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
            { id: statementId, name: "Witness statement.docx" },
          ].map(({ id, name }) => ({
            id,
            workspaceId,
            kind: "document" as const,
            name,
            createdBy: userId,
          })),
        ]);
        await db
          .insert(entityVersions)
          .values({ id: ledgerVersionId, workspaceId, entityId: ledgerId });
        await db.insert(legalListItems).values(
          facts.map(({ id }, index) => ({
            entityId: id,
            workspaceId,
            listId,
            position: String.fromCodePoint(97 + index),
            addedBy: userId,
          })),
        );
        await db.insert(legalListFactDetails).values([
          {
            itemEntityId: paymentFactId,
            workspaceId,
            listId,
            occurredOn: "2021-08-23",
            occurredOnPrecision: "day",
            updatedBy: userId,
          },
          {
            itemEntityId: agreementFactId,
            workspaceId,
            listId,
            occurredOn: "2021-08-01",
            occurredOnPrecision: "month",
            updatedBy: userId,
          },
        ]);
        await db.insert(legalListItemSources).values({
          id: createSafeId<"legalListItemSource">(),
          workspaceId,
          listId,
          itemEntityId: paymentFactId,
          sourceEntityId: ledgerId,
          sourceEntityVersionId: ledgerVersionId,
          locator: { type: "pdf-page" as const, pageNumber: 14 },
          quote: "23/08 transfer 12,000",
          createdBy: userId,
        });
        const pinned = facts.map(({ id, name }): VerificationEvidenceFact => ({
          factEntityId: id,
          text: name,
          occurredOn: null,
          occurredOnPrecision: null,
          evidenceKind: null,
          medium: null,
          confidence: "high",
          interpretationNote: null,
          sources: [],
        }));
        await db.insert(legalListVerificationRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          entityId: statementId,
          fileFieldId,
          entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
          contentSha256: "d".repeat(64),
          evidence: { listId, facts: pinned },
          status: "completed",
          createdAt: new Date("2026-11-02T10:00:00Z"),
        });
        await createScopedDb(
          db,
          [workspaceId],
          organizationId,
          userId,
        )(async (tx) => {
          await tx.insert(legalListClaims).values({
            id: createSafeId<"legalListClaim">(),
            workspaceId,
            runId,
            position: 0,
            type: "fact",
            text: "The ledger shows the payment.",
            anchor: { type: "docx-block", blockId: "p11", start: 0, end: 10 },
            paragraphNumber: 11,
            state: "supported",
            score: 90,
            refs: [{ factEntityId: paymentFactId, rel: "supports" }],
          });
        });

        const audited: { action: string; operation: unknown }[] = [];
        const download = async (
          query: { listId: SafeId<"legalList">; format: "csv" | "docx" },
          scope: SafeId<"workspace"> = workspaceId,
        ) =>
          await exportVerificationChronology.handler(
            createTestHandlerContext<
              Parameters<typeof exportVerificationChronology.handler>[0]
            >({
              audit: auditRecorderDouble((events) => {
                for (const event of events) {
                  audited.push({
                    action: event.action,
                    operation: event.metadata?.["operation"],
                  });
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

        const csv = await download({ listId, format: "csv" });
        if (!(csv instanceof Response)) {
          throw new TypeError(`Expected a file, got ${JSON.stringify(csv)}`);
        }
        expect(csv.headers.get("content-type")).toContain("text/csv");
        expect(csv.headers.get("content-disposition")).toContain("attachment");
        // A month-precision date before a day of that month, the undated
        // fact last; the cited fact names its source page and its claim
        // with the paragraph it sits in and its verdict.
        expect((await csv.text()).split("\n")).toEqual([
          "Date,Fact,Source,Citing claims",
          "2021-08,Agreement signed in August,,",
          '2021-08-23,Ledger records the payment on 23 Aug,"Ledger export.pdf, p. 14",Witness statement.docx ¶ 11: The ledger shows the payment. (Supported)',
          ',"Handwritten note, undated",,',
        ]);
        // The run's claims were delivered, so the run is audited as read,
        // and the download is audited as the list's chronology.
        expect(audited).toContainEqual({
          action: AUDIT_ACTION.DOWNLOAD,
          operation: "verification_chronology_exported",
        });
        expect(
          audited.some(({ action }) => action === AUDIT_ACTION.ACCESS),
        ).toBe(true);

        const docx = await download({ listId, format: "docx" });
        if (!(docx instanceof Response)) {
          throw new TypeError(`Expected a file, got ${JSON.stringify(docx)}`);
        }
        const archive = await ZipArchive.read(await docx.arrayBuffer());
        const body = await archive.entry("word/document.xml")?.text();
        expect(body).toContain("Agreement signed in August");
        expect(body).toContain("Ledger export.pdf, p. 14");
        expect((body ?? "").indexOf("Agreement signed in August")).toBeLessThan(
          (body ?? "").indexOf("Handwritten note"),
        );

        // A list of a matter outside the caller's scope reads as absent,
        // and so does an id no list has.
        expect(
          await download({ listId: foreignListId, format: "csv" }),
        ).toMatchObject({ code: 404 });
        expect(
          await download({
            listId: createSafeId<"legalList">(),
            format: "csv",
          }),
        ).toMatchObject({ code: 404 });
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
