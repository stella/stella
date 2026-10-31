import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { OutboundEmailPreview } from "@stll/api-contract/outbound-action";

import { member, organization, user } from "@/api/db/auth-schema";
import { chatThreads, outboundActions } from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import confirmOutboundAction, {
  createConfirmOutboundActionHandler,
} from "@/api/handlers/outbound-actions/confirm";
import discardOutboundAction from "@/api/handlers/outbound-actions/discard";
import { outboundPreviewHash } from "@/api/handlers/outbound-actions/preview";
import readOutboundAction from "@/api/handlers/outbound-actions/read";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

const preview = {
  kind: "email.send",
  from: { address: "sender@example.test" },
  to: [{ address: "recipient@example.test" }],
  cc: [],
  bcc: [],
  subject: "Agreement",
  bodyText: "Please review the agreement.",
  attachments: [],
  inReplyTo: null,
} satisfies OutboundEmailPreview;
const previewHash = outboundPreviewHash(preview);

export const seedOutboundActionScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const threadId = createSafeId<"chatThread">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Action scaling organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Action scaling actor",
    email: `${userId}@example.test`,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(chatThreads).values({
    id: threadId,
    organizationId,
    userId,
    title: "Prepared actions",
  });
  const encrypted = await encryptContent(
    organizationId,
    JSON.stringify(preview),
  );
  const actions = Array.from({ length: size }, () => ({
    id: createSafeId<"outboundAction">(),
    organizationId,
    userId,
    chatThreadId: threadId,
    kind: preview.kind,
    status: "pending" as const,
    previewEncrypted: encrypted.ciphertext,
    previewIv: encrypted.iv,
    previewHash,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  }));
  await db.insert(outboundActions).values(actions);
  const safeDb = createMembershipSafeDb(markRlsDatabase(db), {
    organizationId,
    userId,
    serverValidatedWorkspaceIds: [],
  });
  const request = new Request("https://example.test/outbound-action-scaling");
  let executions = 0;
  const configuredConfirm = createConfirmOutboundActionHandler({
    "email.send": async () => {
      executions += 1;
      return await Promise.resolve(
        Result.ok({ providerMessageId: "message-1" }),
      );
    },
  });
  if (configuredConfirm.config !== confirmOutboundAction.config) {
    panic("Scaling must use the mounted confirmation contract");
  }
  return {
    readId: actions.at(0)?.id ?? panic("Read action required"),
    confirmId: actions.at(1)?.id ?? panic("Confirm action required"),
    discardId: actions.at(2)?.id ?? panic("Discard action required"),
    configuredConfirm,
    executions: () => executions,
    context: {
      user: { id: userId, email: `${userId}@example.test` },
      session: { activeOrganizationId: organizationId },
      safeDb,
      scopedDb: NO_DB,
      audit: createAuditRecorder({
        organizationId,
        userId,
        workspaceId: null,
        request,
        server: null,
      }),
      request,
    },
    cleanup: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type OutboundScalingFixture = Awaited<
  ReturnType<typeof seedOutboundActionScaling>
>;

export const outboundActionScalingScenarios = [
  {
    name: "outbound action preview",
    type: "read",
    expectedRows: 1,
    definition: readOutboundAction,
    measure: async (fixture: OutboundScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readOutboundAction.handler(
          createTestHandlerContext<
            Parameters<typeof readOutboundAction.handler>[0]
          >({
            ...fixture.context,
            params: { actionId: fixture.readId },
            route: "/v1/outbound-actions/:actionId",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.id !== fixture.readId ||
          response.previewHash !== previewHash
        ) {
          panic("Scaling requires the stored outbound preview");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "outbound action confirmation",
    type: "write",
    expectedRows: 1,
    definition: confirmOutboundAction,
    measure: async (fixture: OutboundScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await fixture.configuredConfirm.handler(
          createTestHandlerContext<
            Parameters<typeof confirmOutboundAction.handler>[0]
          >({
            ...fixture.context,
            params: { actionId: fixture.confirmId },
            body: { previewHash },
            route: "/v1/outbound-actions/:actionId/confirm",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.status !== "sent" ||
          fixture.executions() !== 1
        ) {
          panic("Scaling requires one confirmed delivery");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "outbound action discard",
    type: "write",
    expectedRows: 1,
    definition: discardOutboundAction,
    measure: async (fixture: OutboundScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await discardOutboundAction.handler(
          createTestHandlerContext<
            Parameters<typeof discardOutboundAction.handler>[0]
          >({
            ...fixture.context,
            params: { actionId: fixture.discardId },
            route: "/v1/outbound-actions/:actionId/discard",
          }),
        );
        if (response instanceof HttpStatusResponse || !response.discarded) {
          panic("Scaling requires a discarded action");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
] as const;
