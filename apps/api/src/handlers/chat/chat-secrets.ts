import { panic } from "better-result";
import { and, eq, gt, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { abortTransaction, transactionAbortError } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  chatSecrets,
  mcpUserConnections,
  MCP_RESPONSE_DISPOSITION,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { EncryptedSecret } from "@/api/lib/mcp-upstream/crypto";

const CHAT_SECRET_LIFETIME_MS = DAY_IN_MS;

const chatSecretTargetOrigin = (targetUrl: string) =>
  targetUrl === "" ? "" : new URL(targetUrl).origin;

type ChatSecretScope = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
};

export type ChatSecretReceipt =
  | { status: "provided"; secretRef: string }
  | { status: "declined" };

const receiptFromRow = ({
  id,
  status,
}: {
  id: string;
  status: "provided" | "declined";
}): ChatSecretReceipt => {
  switch (status) {
    case "provided":
      return { status, secretRef: id };
    case "declined":
      return { status };
    default:
      return panic("Unknown chat secret decision");
  }
};

type GetChatSecretReceiptOptions = ChatSecretScope & {
  tx: Transaction;
  toolCallId: string;
};

export const getChatSecretReceipt = async ({
  tx,
  organizationId,
  userId,
  threadId,
  toolCallId,
}: GetChatSecretReceiptOptions) => {
  const row = (
    await tx
      .select({ id: chatSecrets.id, status: chatSecrets.decision })
      .from(chatSecrets)
      .where(
        and(
          eq(chatSecrets.organizationId, organizationId),
          eq(chatSecrets.userId, userId),
          eq(chatSecrets.threadId, threadId),
          eq(chatSecrets.toolCallId, toolCallId),
        ),
      )
      .limit(1)
  ).at(0);
  return row ? receiptFromRow(row) : undefined;
};

type StoreChatSecretOptions = GetChatSecretReceiptOptions & {
  connectorId: SafeId<"mcpConnector"> | null;
  targetUrl: string;
  targetSlug: string;
  targetConnectionId: string | null;
  decision: ({ status: "provided" } & EncryptedSecret) | { status: "declined" };
};

export const storeChatSecret = async ({
  tx,
  organizationId,
  userId,
  threadId,
  toolCallId,
  connectorId,
  targetUrl,
  targetSlug,
  targetConnectionId,
  decision,
}: StoreChatSecretOptions): Promise<ChatSecretReceipt> => {
  // audit: skip - Request receipts are ephemeral bookkeeping in the audited submission transaction.
  const createdAt = new Date();
  const encrypted =
    decision.status === "provided"
      ? { ciphertext: decision.ciphertext, iv: decision.iv }
      : { ciphertext: null, iv: null };
  const row = (
    await tx
      .insert(chatSecrets)
      .values({
        organizationId,
        userId,
        threadId,
        toolCallId,
        connectorId,
        targetUrl: chatSecretTargetOrigin(targetUrl),
        targetSlug,
        targetConnectionId,
        createdAt,
        decision: decision.status,
        ...encrypted,
        expiresAt: new Date(createdAt.getTime() + CHAT_SECRET_LIFETIME_MS),
        remainingUses: decision.status === "provided" ? 8 : 0,
      })
      .onConflictDoNothing({
        target: [
          chatSecrets.organizationId,
          chatSecrets.userId,
          chatSecrets.threadId,
          chatSecrets.toolCallId,
        ],
      })
      .returning({ id: chatSecrets.id, status: chatSecrets.decision })
  ).at(0);
  if (row) {
    return receiptFromRow(row);
  }
  const existing = await getChatSecretReceipt({
    tx,
    organizationId,
    userId,
    threadId,
    toolCallId,
  });
  return existing ?? panic("Chat secret receipt missing after insert conflict");
};

type ConsumeChatSecretOptions = ChatSecretScope & {
  safeDb: SafeDb;
  connectorId: SafeId<"mcpConnector">;
  targetUrl: string;
  secretRef: string;
  targetConnectionId: string;
};

export const consumeChatSecret = async ({
  safeDb,
  organizationId,
  userId,
  threadId,
  connectorId,
  targetUrl,
  secretRef,
  targetConnectionId,
}: ConsumeChatSecretOptions) => {
  const consumed = await safeDb(async (tx) => {
    // audit: skip - Consuming a private reference updates ephemeral use bookkeeping only.
    const scope = and(
      eq(chatSecrets.organizationId, organizationId),
      eq(chatSecrets.userId, userId),
      eq(chatSecrets.threadId, threadId),
      eq(chatSecrets.connectorId, connectorId),
      eq(chatSecrets.targetConnectionId, targetConnectionId),
      eq(chatSecrets.targetUrl, chatSecretTargetOrigin(targetUrl)),
      eq(chatSecrets.id, secretRef),
    );
    await withAggregateLock({
      aggregate: "chatSecret",
      mode: "update",
      tx,
      id: { id: secretRef, organizationId, userId, threadId },
    });
    const row = (
      await tx
        .select({
          ciphertext: chatSecrets.ciphertext,
          iv: chatSecrets.iv,
          remainingUses: chatSecrets.remainingUses,
        })
        .from(chatSecrets)
        .where(
          and(
            scope,
            eq(chatSecrets.decision, "provided"),
            gt(chatSecrets.expiresAt, new Date()),
            gt(chatSecrets.remainingUses, 0),
          ),
        )
        .limit(1)
    ).at(0);
    if (row) {
      if (!row.ciphertext || !row.iv) {
        return panic("Provided chat secret has no encrypted envelope");
      }
      const remainingUses = row.remainingUses - 1;
      await tx
        .update(chatSecrets)
        .set({
          remainingUses,
          ...(remainingUses === 0 ? { ciphertext: null, iv: null } : {}),
        })
        .where(scope);
      return { ciphertext: row.ciphertext, iv: row.iv };
    }
    const existing = (
      await tx
        .select({ id: chatSecrets.id })
        .from(chatSecrets)
        .where(scope)
        .limit(1)
    ).at(0);
    if (!existing) {
      return abortTransaction(
        new HandlerError({
          status: 404,
          code: "CHAT_SECRET_UNKNOWN",
          message: "Chat secret reference not found",
        }),
      );
    }
    return abortTransaction(
      new HandlerError({
        status: 409,
        code: "CHAT_SECRET_UNAVAILABLE",
        message: "Chat secret reference is no longer available",
      }),
    );
  });
  return consumed.mapError(transactionAbortError);
};

type SavedChatSecretOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  connectorId: SafeId<"mcpConnector">;
  targetUrl: string;
};

type SaveChatSecretForFutureOptions = SavedChatSecretOptions & {
  encrypted: EncryptedSecret;
  normalConnectionAction?: "preserve" | "replace-with-receipt-only";
};

export const saveChatSecretForFuture = async ({
  tx,
  organizationId,
  userId,
  connectorId,
  targetUrl,
  encrypted,
  normalConnectionAction = "preserve",
}: SaveChatSecretForFutureOptions) => {
  // audit: skip - Explicit consent storage participates in the audited submission transaction.
  const saved = {
    responseDisposition: MCP_RESPONSE_DISPOSITION.receiptOnly,
    responseTargetUrl: chatSecretTargetOrigin(targetUrl),
    staticTokenEncrypted: encrypted.ciphertext,
    staticTokenIv: encrypted.iv,
    accessTokenEncrypted: null,
    accessTokenIv: null,
    refreshTokenEncrypted: null,
    refreshTokenIv: null,
    tokenType: "Bearer",
    resourceUrl: null,
    authorizationServerUrl: null,
    scope: null,
    expiresAt: null,
    refreshLeaseExpiresAt: null,
    refreshRetryAfter: null,
    cachedTools: null,
    cachedToolsRefreshedAt: null,
    instructions: null,
    serverVersion: null,
    enabled: true,
    updatedAt: new Date(),
  } as const;
  const written = await tx
    .insert(mcpUserConnections)
    .values({
      organizationId,
      userId,
      connectorId,
      status: "connected",
      ...saved,
    })
    .onConflictDoUpdate({
      target: [
        mcpUserConnections.organizationId,
        mcpUserConnections.connectorId,
        mcpUserConnections.userId,
      ],
      // Receipt reuse follows consent and enabled, independently of connection lifecycle.
      set: saved,
      setWhere:
        normalConnectionAction === "replace-with-receipt-only"
          ? sql`true`
          : eq(
              mcpUserConnections.responseDisposition,
              MCP_RESPONSE_DISPOSITION.receiptOnly,
            ),
    })
    .returning({ id: mcpUserConnections.id });
  if (written.length === 0) {
    abortTransaction(
      new HandlerError({
        status: 409,
        code: "CHAT_SAVED_CONNECTION_EXISTS",
        message: "A connector connection already exists",
      }),
    );
  }
};

export const readSavedChatSecret = async ({
  tx,
  organizationId,
  userId,
  connectorId,
  targetUrl,
}: SavedChatSecretOptions) => {
  const row = (
    await tx
      .select({
        ciphertext: mcpUserConnections.staticTokenEncrypted,
        iv: mcpUserConnections.staticTokenIv,
      })
      .from(mcpUserConnections)
      .where(
        and(
          eq(mcpUserConnections.organizationId, organizationId),
          eq(mcpUserConnections.userId, userId),
          eq(mcpUserConnections.connectorId, connectorId),
          eq(
            mcpUserConnections.responseTargetUrl,
            chatSecretTargetOrigin(targetUrl),
          ),
          eq(
            mcpUserConnections.responseDisposition,
            MCP_RESPONSE_DISPOSITION.receiptOnly,
          ),
          eq(mcpUserConnections.enabled, true),
        ),
      )
      .limit(1)
  ).at(0);
  if (!row) {
    return undefined;
  }
  if (!row.ciphertext || !row.iv) {
    return panic("Saved chat connection has no encrypted envelope");
  }
  return { ciphertext: row.ciphertext, iv: row.iv };
};
