import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { OUTBOUND_ACTION_STATUSES } from "@stll/api-contract/outbound-action";

import { member, organization, user } from "@/api/db/auth-schema";
import { chatThreads, outboundActions } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];

const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgres)("outbound action offboarding", () => {
  test("member removal clears pending outbound actions and retains every delivery outcome", async () => {
    const url = databaseUrl ?? panic("DATABASE_URL required");
    await withGatedTestClients(url, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const actorUserId = mintAuthProviderId<"user">();
      const memberId = Bun.randomUUIDv7();
      const threadId = createSafeId<"chatThread">();
      await db.insert(user).values(
        [userId, actorUserId].map((id) => ({
          id,
          name: "Action member",
          email: `${id}@example.test`,
        })),
      );
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Action organization",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(member).values({
          id: memberId,
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        await db.insert(chatThreads).values({
          id: threadId,
          organizationId,
          userId,
          title: "Prepared actions",
        });
        const actions = OUTBOUND_ACTION_STATUSES.map((status) => ({
          id: createSafeId<"outboundAction">(),
          organizationId,
          userId,
          chatThreadId: threadId,
          kind: "email.send" as const,
          status,
          previewEncrypted: Buffer.from("preview"),
          previewIv: Buffer.alloc(12),
          previewHash: "a".repeat(64),
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          providerMessageId: status === "sent" ? "provider-message" : null,
          failureCode: status === "failed" ? "recipient_rejected" : null,
        }));
        await db.insert(outboundActions).values(actions);
        await db.transaction(async (tx) => {
          await removeOrganizationMemberInTransaction(tx, {
            organizationId,
            userId,
            memberId,
            actorUserId,
          });
        });
        const remaining = await db
          .select({
            id: outboundActions.id,
            status: outboundActions.status,
            providerMessageId: outboundActions.providerMessageId,
            failureCode: outboundActions.failureCode,
          })
          .from(outboundActions)
          .where(eq(outboundActions.organizationId, organizationId));
        const expected = actions
          .filter(({ status }) => status !== "pending")
          .map(({ id, status, providerMessageId, failureCode }) => ({
            id,
            status,
            providerMessageId,
            failureCode,
          }));
        expect(remaining).toHaveLength(expected.length);
        expect(remaining).toEqual(expect.arrayContaining(expected));
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
        await db.delete(user).where(eq(user.id, actorUserId));
      }
    });
  });
});
