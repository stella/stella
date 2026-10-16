import { Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import {
  CONNECT_CONNECTOR_TOOL_NAME,
  CONNECT_CONNECTOR_NOT_CONNECTED_CODE,
  connectConnectorInputSchema,
  connectConnectorSubmissionSchema,
} from "@stll/api-contract/chat-connector";
import type { ConnectConnectorOutput } from "@stll/api-contract/chat-connector";

import type { Transaction } from "@/api/db/root";
import { abortableTx, abortTransaction } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  chatTurns,
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpUserConnections,
  MCP_RESPONSE_DISPOSITION,
} from "@/api/db/schema";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { approvedMcpAuthorizationReview } from "@/api/lib/mcp-upstream/authorization-review";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: t.Object({
    threadId: tSafeId("chatThread"),
    toolCallId: t.String({ minLength: 1, maxLength: 200 }),
  }),
  body: t.Unknown(),
} satisfies HandlerConfig;

type PendingRequestOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
  toolCallId: string;
};

const notPending = () =>
  new HandlerError({
    status: 409,
    message: "Connector request is no longer pending",
  });

/** The persisted `connect_connector` call this turn is waiting on. */
const readPendingRequest = async ({
  tx,
  organizationId,
  userId,
  threadId,
  toolCallId,
}: PendingRequestOptions) => {
  await withAggregateLock({
    aggregate: "chatTurn",
    mode: "update",
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
  if (!turn || turn.status !== "awaiting-user") {
    return Result.err(notPending());
  }
  const part = normalizePersistedChatMessageContent(turn.content).parts.find(
    (candidate) =>
      candidate.type === "tool-call" &&
      candidate.id === toolCallId &&
      candidate.name === CONNECT_CONNECTOR_TOOL_NAME,
  );
  if (
    !part ||
    part.type !== "tool-call" ||
    part.state === "complete" ||
    part.state === "error"
  ) {
    return Result.err(notPending());
  }
  const input = v.safeParse(connectConnectorInputSchema, part.input);
  if (!input.success) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Connector request is unavailable",
      }),
    );
  }
  return Result.ok(input.output);
};

type ConnectedConnectorOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  connectorSlug: string;
};

/**
 * Whether this user's connection would load the connector's tools on the
 * next turn: the same conditions the per-send connector load applies.
 */
const hasUsableConnection = async ({
  tx,
  organizationId,
  userId,
  connectorSlug,
}: ConnectedConnectorOptions): Promise<boolean> => {
  const connections = await tx
    .select({ id: mcpUserConnections.id })
    .from(mcpConnectors)
    .innerJoin(
      mcpUserConnections,
      and(
        eq(mcpUserConnections.connectorId, mcpConnectors.id),
        eq(mcpUserConnections.organizationId, organizationId),
        eq(mcpUserConnections.userId, userId),
        eq(mcpUserConnections.enabled, true),
        eq(mcpUserConnections.status, "connected"),
        eq(
          mcpUserConnections.responseDisposition,
          MCP_RESPONSE_DISPOSITION.normal,
        ),
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
    .limit(1);
  return connections.length > 0;
};

/**
 * Answers a `connect_connector` card. The card runs the ordinary connect flow
 * and reports what the user did; the receipt says `connected` only when this
 * user's connection is stored and usable, so the model never hears of a
 * connection the next turn would not load. Nothing is stored here: a retry
 * while the turn still waits re-reads the same state and answers the same.
 */
const submitConnector = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { threadId, toolCallId },
    safeDb,
    session,
    user,
    memberRole,
  }) {
    const submission = v.safeParse(connectConnectorSubmissionSchema, body);
    if (!submission.success) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid connector request answer",
        }),
      );
    }
    const { decision } = submission.output;
    if (
      decision === "connected" &&
      !hasMemberPermission(memberRole, { integration: ["create"] })
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Connector access is unavailable",
        }),
      );
    }
    const receipt = yield* Result.await(
      abortableTx(safeDb, async (tx): Promise<ConnectConnectorOutput> => {
        await withAggregateLock({
          aggregate: "chatThread",
          mode: "update",
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
          return abortTransaction(
            new HandlerError({ status: 404, message: "Chat thread not found" }),
          );
        }
        const input = await readPendingRequest({
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          threadId,
          toolCallId,
        });
        if (input.isErr()) {
          return abortTransaction(input.error);
        }
        const { connectorSlug } = input.value;
        if (decision === "declined") {
          return { status: "declined", connectorSlug };
        }
        const connected = await hasUsableConnection({
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          connectorSlug,
        });
        if (!connected) {
          return abortTransaction(
            new HandlerError({
              status: 409,
              code: CONNECT_CONNECTOR_NOT_CONNECTED_CODE,
              message: "Connector is not connected yet",
            }),
          );
        }
        return { status: "connected", connectorSlug };
      }),
    );
    return Result.ok(receipt);
  },
);
// The thread fence comes first; the request's turn fence follows in rank
// order inside the same transaction.
declareAggregateMutation(submitConnector.handler, {
  type: "aggregate",
  aggregates: ["chatThread"],
});

export default submitConnector;
