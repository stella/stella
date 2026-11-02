import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
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

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("reader-answer account deletion", () => {
  test("deletes private threads and retains shared organization threads", async () => {
    const organizationId = mintAuthProviderId<"organization">();
    const targetUserId = mintAuthProviderId<"user">();
    const retainedOwnerId = mintAuthProviderId<"user">();
    const targetEmail = `${targetUserId.toLowerCase()}@reader-deletion.test`;
    const privateAnswerId = createSafeId<"legalReaderAnswer">();
    const sharedAnswerId = createSafeId<"legalReaderAnswer">();
    const answerIds = [privateAnswerId, sharedAnswerId];

    await rootDb.insert(user).values([
      {
        id: targetUserId,
        name: "Reader deletion target",
        email: targetEmail,
        emailVerified: true,
      },
      {
        id: retainedOwnerId,
        name: "Reader deletion retained owner",
        email: `${retainedOwnerId.toLowerCase()}@reader-deletion.test`,
        emailVerified: true,
      },
    ]);
    try {
      await rootDb.insert(organization).values({
        id: organizationId,
        name: "Reader answer deletion",
        slug: organizationId,
        createdAt: new Date(),
      });
      await recordNewOrganizationAccessState(rootDb, {
        organizationId,
        now: new Date(),
      });
      await rootDb.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: targetUserId,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: retainedOwnerId,
          role: "owner",
          createdAt: new Date(),
        },
      ]);
      const readerDb = createScopedDb(
        markRlsDatabase(rootDb),
        [],
        organizationId,
        targetUserId,
      );
      await readerDb(async (tx) => {
        await tx.insert(legalReaderAnswers).values([
          {
            id: privateAnswerId,
            organizationId,
            userId: targetUserId,
            decisionId: createSafeId<"caseLawDecision">(),
            kind: "ask",
            visibility: "private",
            paragraphId: "p-private",
            quote: "Private legal quotation",
            startOffset: 0,
            endOffset: 23,
          },
          {
            id: sharedAnswerId,
            organizationId,
            userId: targetUserId,
            decisionId: createSafeId<"caseLawDecision">(),
            kind: "explain",
            visibility: "shared",
            paragraphId: "p-shared",
            quote: "Shared legal quotation",
            startOffset: 0,
            endOffset: 22,
          },
        ]);
        await tx.insert(legalReaderAnswerMessages).values([
          {
            id: createSafeId<"legalReaderAnswerMessage">(),
            answerId: privateAnswerId,
            sequence: 1,
            role: "user",
            content: "Private user question",
            status: "complete",
          },
          {
            id: createSafeId<"legalReaderAnswerMessage">(),
            answerId: privateAnswerId,
            sequence: 2,
            role: "assistant",
            content: "Private generated answer",
            status: "complete",
          },
          {
            id: createSafeId<"legalReaderAnswerMessage">(),
            answerId: sharedAnswerId,
            sequence: 1,
            role: "user",
            content: "Shared user question",
            status: "complete",
          },
          {
            id: createSafeId<"legalReaderAnswerMessage">(),
            answerId: sharedAnswerId,
            sequence: 2,
            role: "assistant",
            content: "Shared generated answer",
            status: "complete",
          },
        ]);
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
          .select({ deletedAt: user.deletedAt, email: user.email })
          .from(user)
          .where(eq(user.id, targetUserId))
      ).at(0);
      const { survivingAnswers, survivingMessages } = await readerDb(
        async (tx) => ({
          survivingAnswers: await tx
            .select({
              id: legalReaderAnswers.id,
              visibility: legalReaderAnswers.visibility,
            })
            .from(legalReaderAnswers)
            .where(inArray(legalReaderAnswers.id, answerIds))
            .orderBy(asc(legalReaderAnswers.visibility)),
          survivingMessages: await tx
            .select({ answerId: legalReaderAnswerMessages.answerId })
            .from(legalReaderAnswerMessages)
            .where(inArray(legalReaderAnswerMessages.answerId, answerIds)),
        }),
      );

      expect(deletedAccount?.deletedAt).toBeInstanceOf(Date);
      expect(deletedAccount?.email).not.toBe(targetEmail);
      expect(survivingAnswers).toEqual([
        { id: sharedAnswerId, visibility: "shared" },
      ]);
      expect(survivingMessages).toEqual([
        { answerId: sharedAnswerId },
        { answerId: sharedAnswerId },
      ]);
    } finally {
      await rootDb
        .delete(organization)
        .where(eq(organization.id, organizationId));
    }
  });
});
