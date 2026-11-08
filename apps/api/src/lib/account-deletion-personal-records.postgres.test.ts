import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";

import { ACCOUNT_ERASURE_USER_SETTING } from "@/api/db/account-erasure-policies";
import { member, organization, user } from "@/api/db/auth-schema";
import {
  SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID,
  SETTING_ACCOUNT_EXPORT_USER_ID,
} from "@/api/db/rls";
import { rootDb } from "@/api/db/root";
import {
  billingDraftUserSettings,
  feedbackReports,
  legalReaderAnnotations,
  savedSearches,
  savedTimeNarratives,
  templateLookupFormats,
  templateLookupFormatUserDefaults,
  userProfessionalUseAcceptances,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { verifyAndDeleteUser } from "@/api/lib/delete-account";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

// timeout: Account deletion runs every erasure step against real PostgreSQL.
setDefaultTimeout(120_000);

const clock = createTestClock();

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("account deletion personal records", () => {
  test("erases the account's exported personal records and keeps shared notes and filed feedback", async () => {
    const organizationId = mintAuthProviderId<"organization">();
    const targetUserId = mintAuthProviderId<"user">();
    const retainedOwnerId = mintAuthProviderId<"user">();
    const targetEmail = `${targetUserId.toLowerCase()}@personal-records.test`;
    const privateNoteId = createSafeId<"legalReaderAnnotation">();
    const sharedNoteId = createSafeId<"legalReaderAnnotation">();
    const decisionId = createSafeId<"caseLawDecision">();
    const formatId = createSafeId<"templateLookupFormat">();
    const feedbackId = createSafeId<"feedbackReport">();
    const receiptAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const receiptPart = () =>
      Array.from(
        crypto.getRandomValues(new Uint8Array(4)),
        (byte) => receiptAlphabet[byte % receiptAlphabet.length],
      ).join("");

    await rootDb.insert(user).values([
      {
        id: targetUserId,
        name: "Personal records target",
        email: targetEmail,
        emailVerified: true,
      },
      {
        id: retainedOwnerId,
        name: "Personal records retained owner",
        email: `${retainedOwnerId.toLowerCase()}@personal-records.test`,
        emailVerified: true,
      },
    ]);
    try {
      await rootDb.insert(organization).values({
        id: organizationId,
        name: "Personal records deletion",
        slug: organizationId,
        createdAt: new Date(clock.now()),
      });
      await recordNewOrganizationAccessState(rootDb, {
        organizationId,
        now: new Date(clock.now()),
      });
      await rootDb.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: targetUserId,
          role: "owner",
          createdAt: new Date(clock.now()),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: retainedOwnerId,
          role: "owner",
          createdAt: new Date(clock.now()),
        },
      ]);
      const targetDb = createScopedDb(
        markRlsDatabase(rootDb),
        [],
        organizationId,
        targetUserId,
      );
      await targetDb(async (tx) => {
        await tx.insert(legalReaderAnnotations).values(
          (
            [
              [privateNoteId, "private"],
              [sharedNoteId, "shared"],
            ] as const
          ).map(([id, visibility]) => ({
            id,
            organizationId,
            userId: targetUserId,
            targetType: "decision" as const,
            targetId: decisionId,
            kind: "comment" as const,
            visibility,
            blockAnchorId: "p1",
            startOffset: 0,
            endOffset: 5,
            quote: "quote",
            body: `${visibility} note`,
          })),
        );
        await tx.insert(savedTimeNarratives).values({
          id: createSafeId<"savedTimeNarrative">(),
          organizationId,
          userId: targetUserId,
          name: "Narrative",
          narrative: "Personal narrative text",
        });
        await tx.insert(billingDraftUserSettings).values({
          organizationId,
          userId: targetUserId,
          preference: "Personal billing preference",
        });
      });
      await rootDb.insert(savedSearches).values({
        id: createSafeId<"savedSearch">(),
        organizationId,
        userId: targetUserId,
        name: "Saved search",
        criteria: {
          version: 1,
          query: "personal query",
          workspaceIds: [],
          types: [],
          kinds: [],
          editedByUserIds: [],
          mimeTypes: [],
          sort: "relevance",
        },
      });
      await rootDb.insert(templateLookupFormats).values({
        id: formatId,
        organizationId,
        registry: "ares",
        name: "Organization format",
        format: "[company name]",
      });
      await rootDb.insert(templateLookupFormatUserDefaults).values({
        userId: targetUserId,
        organizationId,
        registry: "ares",
        formatId,
      });
      await rootDb.insert(userProfessionalUseAcceptances).values({
        userId: targetUserId,
        statementVersion: "fixture",
        termsVersion: "fixture",
        source: "interactive",
      });
      await rootDb.insert(feedbackReports).values({
        id: feedbackId,
        receipt: `FB-${receiptPart()}-${receiptPart()}`,
        kind: "bug",
        area: "matters",
        title: "Filed feedback",
        whatHappened: "Something happened",
        serverVersion: "fixture",
        via: "web",
        userId: targetUserId,
        organizationId,
        redactions: 0,
        fingerprint: feedbackId,
      });

      const otp = await createConfirmationOtp({
        purpose: "delete-account",
        email: targetEmail,
      });
      if (Result.isError(otp)) {
        panic(otp.error.message);
      }
      const deletion = await verifyAndDeleteUser(
        brandPersistedUserId(targetUserId),
        targetEmail,
        otp.value,
      );
      if (Result.isError(deletion)) {
        panic(deletion.error.message);
      }

      const deletedAccount = (
        await rootDb
          .select({ deletedAt: user.deletedAt })
          .from(user)
          .where(eq(user.id, targetUserId))
      ).at(0);
      expect(deletedAccount?.deletedAt).toBeInstanceOf(Date);

      // Owner reads of forced-RLS tables go through the settings their
      // owner policies name.
      const remaining = await rootDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config(${SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID}, ${organizationId}, true)`,
        );
        await tx.execute(
          sql`SELECT set_config(${SETTING_ACCOUNT_EXPORT_USER_ID}, ${targetUserId}, true)`,
        );
        await tx.execute(
          sql`SELECT set_config(${ACCOUNT_ERASURE_USER_SETTING}, ${targetUserId}, true)`,
        );
        return {
          notes: await tx
            .select({
              id: legalReaderAnnotations.id,
              visibility: legalReaderAnnotations.visibility,
            })
            .from(legalReaderAnnotations)
            .where(eq(legalReaderAnnotations.userId, targetUserId))
            .orderBy(asc(legalReaderAnnotations.visibility)),
          narratives: await tx
            .select({ id: savedTimeNarratives.id })
            .from(savedTimeNarratives)
            .where(eq(savedTimeNarratives.userId, targetUserId)),
          billingSettings: await tx
            .select({ userId: billingDraftUserSettings.userId })
            .from(billingDraftUserSettings)
            .where(eq(billingDraftUserSettings.userId, targetUserId)),
        };
      });
      expect(remaining).toEqual({
        notes: [{ id: sharedNoteId, visibility: "shared" }],
        narratives: [],
        billingSettings: [],
      });
      expect(
        await rootDb
          .select({ id: savedSearches.id })
          .from(savedSearches)
          .where(eq(savedSearches.userId, targetUserId)),
      ).toEqual([]);
      expect(
        await rootDb
          .select({ formatId: templateLookupFormatUserDefaults.formatId })
          .from(templateLookupFormatUserDefaults)
          .where(eq(templateLookupFormatUserDefaults.userId, targetUserId)),
      ).toEqual([]);
      expect(
        await rootDb
          .select({ userId: userProfessionalUseAcceptances.userId })
          .from(userProfessionalUseAcceptances)
          .where(eq(userProfessionalUseAcceptances.userId, targetUserId)),
      ).toEqual([]);
      expect(
        await rootDb
          .select({
            id: feedbackReports.id,
            userId: feedbackReports.userId,
          })
          .from(feedbackReports)
          .where(eq(feedbackReports.id, feedbackId)),
      ).toEqual([{ id: feedbackId, userId: null }]);
    } finally {
      await rootDb
        .delete(feedbackReports)
        .where(eq(feedbackReports.id, feedbackId));
      await rootDb
        .delete(organization)
        .where(eq(organization.id, organizationId));
    }
  });
});
