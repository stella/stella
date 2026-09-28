import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceAllowedSenders,
  correspondenceFilers,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await getTestDb();
});
afterAll(releaseTestDb);

test("organization deletion removes shared-mailbox history", async () => {
  try {
    await testDb.transaction(async (tx) => {
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const correspondenceId = createSafeId<"correspondence">();
      const senderId = createSafeId<"correspondenceAllowedSender">();
      await tx.insert(user).values({
        id: userId,
        name: "Approver",
        email: `${userId}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await tx.insert(organization).values({
        id: organizationId,
        name: "Deletion fixture",
        slug: `deletion-${organizationId}`,
        createdAt: new Date(),
      });
      await tx.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Deletion matter",
        reference: "DELETE",
      });
      await tx.insert(correspondence).values({
        id: correspondenceId,
        organizationId,
        workspaceId,
        channel: "email",
        direction: "in",
        intake: "direct",
        authenticatedSenderAddress: "mailbox@example.test",
        contentHash: "a".repeat(64),
        dedupKey: "b".repeat(64),
        from: { address: "mailbox@example.test", name: null },
        to: [],
        cc: [],
        subject: "Deletion fixture",
        receivedAt: new Date(),
        references: [],
        bodyText: "Deletion fixture",
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
      });
      await tx.insert(correspondenceAllowedSenders).values({
        id: senderId,
        organizationId,
        address: "mailbox@example.test",
        kind: "shared_mailbox",
        scope: "organization",
        approvedBy: userId,
        approvedByDisplay: {
          status: "active",
          name: "Approver",
          email: `${userId}@example.test`,
        },
      });
      await tx.insert(correspondenceFilers).values({
        organizationId,
        workspaceId,
        correspondenceId,
        filedByAllowedSenderId: senderId,
      });
      await tx.delete(organization).where(eq(organization.id, organizationId));
      expect(
        await tx
          .select()
          .from(correspondence)
          .where(eq(correspondence.id, correspondenceId)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(correspondenceAllowedSenders)
          .where(eq(correspondenceAllowedSenders.id, senderId)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(correspondenceFilers)
          .where(eq(correspondenceFilers.correspondenceId, correspondenceId)),
      ).toEqual([]);
      tx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return;
    }
    throw error;
  }
});
