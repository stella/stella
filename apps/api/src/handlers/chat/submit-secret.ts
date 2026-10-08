import { panic, Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import {
  REQUEST_SECRET_TOOL_NAME,
  requestSecretInputSchema,
} from "@stll/api-contract/chat-secret";

import type { Transaction } from "@/api/db/root";
import { resultTx } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  chatTurns,
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import { recoverChatSecretSubmission } from "@/api/handlers/chat/chat-secret-retry";
import {
  readSavedChatSecret,
  saveChatSecretForFuture,
  storeChatSecret,
} from "@/api/handlers/chat/chat-secrets";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { approvedMcpAuthorizationReview } from "@/api/lib/mcp-upstream/authorization-review";
import { encryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { secretSchema } from "@/api/lib/secret-brands";

const submissionSchema = v.variant("decision", [
  v.strictObject({
    decision: v.literal("provide"),
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(4096), secretSchema),
    saveForFuture: v.boolean(),
    normalConnectionAction: v.picklist([
      "preserve",
      "replace-with-receipt-only",
    ]),
  }),
  v.strictObject({ decision: v.literal("decline") }),
  v.strictObject({ decision: v.literal("use-saved") }),
]);
const config = {
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: t.Object({
    threadId: tSafeId("chatThread"),
    toolCallId: t.String({ minLength: 1, maxLength: 200 }),
  }),
  // Validate inside the handler so framework validation errors never contain private input.
  body: t.Unknown(),
} satisfies HandlerConfig;

type PendingRequestOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
  toolCallId: string;
};

const readPendingRequest = async ({
  tx,
  organizationId,
  userId,
  threadId,
  toolCallId,
}: PendingRequestOptions) => {
  await withAggregateLock({
    aggregate: "chatTurn",
    tx,
    id: { organizationId, userId, threadId, toolCallId },
  });
  const turn = (
    await tx
      .select({ content: chatMessages.content, status: chatTurns.status })
      .from(chatTurns)
      .innerJoin(
        chatMessages,
        eq(chatMessages.id, chatTurns.assistantMessageId),
      )
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          eq(chatTurns.organizationId, organizationId),
          eq(chatTurns.userId, userId),
          eq(chatTurns.interactionToolCallId, toolCallId),
        ),
      )
      .limit(1)
  ).at(0);
  if (!turn) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Private input request is no longer pending",
      }),
    );
  }
  const part = normalizePersistedChatMessageContent(turn.content).parts.find(
    (candidate) =>
      candidate.type === "tool-call" &&
      candidate.id === toolCallId &&
      candidate.name === REQUEST_SECRET_TOOL_NAME,
  );
  if (!part || part.type !== "tool-call") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Private input request is unavailable",
      }),
    );
  }
  const input = v.safeParse(requestSecretInputSchema, part.input);
  if (!input.success) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Private input request is unavailable",
      }),
    );
  }
  if (turn.status !== "awaiting-user") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Private input request is no longer pending",
      }),
    );
  }
  return Result.ok(input.output);
};

type PreparePrivateInputOptions = {
  scope: Parameters<typeof readSavedChatSecret>[0];
  secretDecision: v.InferOutput<typeof submissionSchema>;
};

const preparePrivateInput = async ({
  scope,
  secretDecision,
}: PreparePrivateInputOptions) => {
  const { organizationId, userId, connectorId } = scope;
  switch (secretDecision.decision) {
    case "decline":
      return Result.ok({ status: "declined" as const });
    case "provide":
      return Result.ok({
        status: "provided" as const,
        ...(await encryptMcpSecret({
          organizationId,
          userId,
          connectorId,
          purpose: "mcp_static_token",
          secret: secretDecision.value,
        })),
      });
    case "use-saved": {
      const encrypted = await readSavedChatSecret(scope);
      if (!encrypted) {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Saved credential is unavailable",
          }),
        );
      }
      return Result.ok({ status: "provided" as const, ...encrypted });
    }
    default:
      secretDecision satisfies never;
      return panic("Unhandled private input decision");
  }
};

type EnabledConnectorOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  connectorSlug: string;
};

const readEnabledConnector = async ({
  tx,
  organizationId,
  userId,
  connectorSlug,
}: EnabledConnectorOptions) => {
  const connectors = await tx
    .select({
      id: mcpConnectors.id,
      authType: mcpConnectors.authType,
      url: mcpConnectors.url,
    })
    .from(mcpConnectors)
    .innerJoin(
      mcpUserConnections,
      and(
        eq(mcpUserConnections.connectorId, mcpConnectors.id),
        eq(mcpUserConnections.organizationId, organizationId),
        eq(mcpUserConnections.userId, userId),
        eq(mcpUserConnections.enabled, true),
      ),
    )
    .leftJoin(
      mcpConnectorAuthorizationReviews,
      and(
        eq(mcpConnectorAuthorizationReviews.connectorId, mcpConnectors.id),
        eq(mcpConnectorAuthorizationReviews.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(mcpConnectors.slug, connectorSlug),
        or(
          isNull(mcpConnectors.organizationId),
          eq(mcpConnectors.organizationId, organizationId),
        ),
        approvedMcpAuthorizationReview,
      ),
    )
    .limit(2);
  const connector = connectors.length === 1 ? connectors.at(0) : undefined;

  return connector;
};

const submitSecret = createSafeRootHandler(
  config,
  async function* ({
    body: credentialBody,
    params: { threadId, toolCallId },
    safeDb,
    session,
    user,
    memberRole,
    recordAuditEvent,
  }) {
    const credentialSubmission = v.safeParse(submissionSchema, credentialBody);
    if (!credentialSubmission.success) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid private input submission",
        }),
      );
    }
    const secretDecision = credentialSubmission.output;
    if (
      secretDecision.decision !== "decline" &&
      !hasMemberPermission(memberRole, { integration: ["create"] })
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Connector access is unavailable",
        }),
      );
    }
    const result = yield* Result.await(
      resultTx(safeDb, async (tx) => {
        await withAggregateLock({
          aggregate: "chatThread",
          tx,
          id: {
            id: threadId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
          },
        });
        const thread = (
          await tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(
              and(
                eq(chatThreads.id, threadId),
                eq(chatThreads.organizationId, session.activeOrganizationId),
                eq(chatThreads.userId, user.id),
              ),
            )
            .limit(1)
        ).at(0);
        if (!thread) {
          return Result.err(
            new HandlerError({ status: 404, message: "Chat thread not found" }),
          );
        }
        const recovery = await recoverChatSecretSubmission({
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          threadId,
          toolCallId,
          secretDecision,
        });
        if (recovery.isErr()) {
          return Result.err(recovery.error);
        }
        if (recovery.value) {
          return Result.ok(recovery.value);
        }
        const scope = {
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          threadId,
          toolCallId,
        };
        const input = await readPendingRequest(scope);
        if (input.isErr()) {
          return Result.err(input.error);
        }
        if (secretDecision.decision === "decline") {
          const receipt = await storeChatSecret({
            ...scope,
            connectorId: null,
            targetUrl: "",
            targetSlug: input.value.target.connectorSlug,
            decision: { status: "declined" },
          });
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
            resourceId: threadId,
            changes: {
              privateInput: {
                old: null,
                new: { status: "declined", savedForFuture: false },
              },
            },
          });
          return Result.ok({ ...receipt, target: input.value.target });
        }
        const connector = await readEnabledConnector({
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          connectorSlug: input.value.target.connectorSlug,
        });
        if (!connector || connector.authType !== "bearer") {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Connector does not accept this credential",
            }),
          );
        }
        if (
          secretDecision.decision === "provide" &&
          !envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY
        ) {
          return Result.err(
            new HandlerError({
              status: 503,
              message: "Private input storage is unavailable",
            }),
          );
        }
        const savedScope = {
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          connectorId: connector.id,
          targetUrl: connector.url,
        };
        const encryptedDecision = await preparePrivateInput({
          scope: savedScope,
          secretDecision,
        });
        if (encryptedDecision.isErr()) {
          return Result.err(encryptedDecision.error);
        }
        const encrypted = encryptedDecision.value;
        const saved = await storeChatSecret({
          ...scope,
          connectorId: connector.id,
          targetUrl: connector.url,
          targetSlug: input.value.target.connectorSlug,
          decision: encrypted,
        });
        if (
          secretDecision.decision === "provide" &&
          secretDecision.saveForFuture &&
          encrypted.status === "provided"
        ) {
          await saveChatSecretForFuture({
            ...savedScope,
            encrypted,
            normalConnectionAction: secretDecision.normalConnectionAction,
          });
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: threadId,
          changes: {
            privateInput: {
              old: null,
              new: {
                status: saved.status,
                savedForFuture:
                  secretDecision.decision === "provide" &&
                  secretDecision.saveForFuture,
              },
            },
          },
        });
        return Result.ok({ ...saved, target: input.value.target });
      }),
    );
    return Result.ok(result);
  },
);
export default submitSecret;
