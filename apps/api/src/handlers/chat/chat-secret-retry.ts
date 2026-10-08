import { Result } from "better-result";
import { and, eq, lt, sql } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";

import type { RequestSecretOutput } from "@stll/api-contract/chat-secret";
import { sha256Bytes } from "@stll/sha256/node";

import type { Transaction } from "@/api/db/root";
import { chatSecrets, chatTurns } from "@/api/db/schema";
import { readSavedChatSecret } from "@/api/handlers/chat/chat-secrets";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { decryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import type { Secret } from "@/api/lib/secret-brands";

type RecoverChatSecretOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
  toolCallId: string;
  secretDecision:
    | {
        decision: "provide";
        value: Secret<"StaticBearerToken">;
        targetConnection: { connectionId: string; host: string };
      }
    | {
        decision: "use-saved";
        targetConnection: { connectionId: string; host: string };
      }
    | { decision: "decline" };
};

/** Same-decision retries allowed per request before the generic conflict. */
const CHAT_SECRET_RETRY_LIMIT = 5;

export const chatSecretSubmissionConflict = () =>
  new HandlerError({
    status: 409,
    code: "CHAT_PRIVATE_INPUT_ALREADY_SUBMITTED",
    message: "Private input was already submitted with a different decision",
  });

/**
 * `conflict` is an outcome rather than an error so the caller can commit the
 * consumed retry attempt before answering with the generic conflict.
 */
type RecoveryOutcome =
  | { kind: "absent" }
  | { kind: "conflict" }
  | { kind: "receipt"; receipt: RequestSecretOutput };

const conflict = (): RecoveryOutcome => ({ kind: "conflict" });

export const recoverChatSecretSubmission = async ({
  tx,
  organizationId,
  userId,
  threadId,
  toolCallId,
  secretDecision,
}: RecoverChatSecretOptions): Promise<RecoveryOutcome> => {
  // audit: skip - The retry counter is bookkeeping inside the audited submission transaction.
  const readStored = () =>
    tx
      .select({
        id: chatSecrets.id,
        status: chatSecrets.decision,
        targetSlug: chatSecrets.targetSlug,
        targetUrl: chatSecrets.targetUrl,
        connectorId: chatSecrets.connectorId,
        targetConnectionId: chatSecrets.targetConnectionId,
        ciphertext: chatSecrets.ciphertext,
        iv: chatSecrets.iv,
      })
      .from(chatSecrets)
      .where(
        and(
          eq(chatSecrets.organizationId, organizationId),
          eq(chatSecrets.userId, userId),
          eq(chatSecrets.threadId, threadId),
          eq(chatSecrets.toolCallId, toolCallId),
        ),
      )
      .limit(1);
  const prior = (await readStored()).at(0);
  if (!prior) {
    return { kind: "absent" };
  }
  // Rank order: the interaction fence precedes the receipt fence, matching
  // the first-submission path that locks the turn after this returns.
  await withAggregateLock({
    aggregate: "chatTurn",
    mode: "update",
    tx,
    id: { organizationId, userId, threadId, toolCallId },
  });
  const turn = (
    await tx
      .select({ status: chatTurns.status })
      .from(chatTurns)
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
  // A retry only resumes a request that is still waiting for this input.
  if (turn?.status !== "awaiting-user") {
    return conflict();
  }
  await withAggregateLock({
    aggregate: "chatSecret",
    mode: "update",
    tx,
    id: { id: prior.id, organizationId, userId, threadId },
  });
  const stored = (await readStored()).at(0);
  if (!stored) {
    return { kind: "absent" };
  }
  const attempt = await tx
    .update(chatSecrets)
    .set({ retryAttempts: sql`${chatSecrets.retryAttempts} + 1` })
    .where(
      and(
        eq(chatSecrets.id, stored.id),
        lt(chatSecrets.retryAttempts, CHAT_SECRET_RETRY_LIMIT),
      ),
    )
    .returning({ id: chatSecrets.id });
  if (attempt.length === 0) {
    return conflict();
  }
  const target = {
    type: "mcp-connector" as const,
    connectorSlug: stored.targetSlug,
  };
  if (stored.status === "declined") {
    return secretDecision.decision === "decline"
      ? { kind: "receipt", receipt: { status: "declined", target } }
      : conflict();
  }
  if (
    secretDecision.decision === "decline" ||
    !stored.connectorId ||
    !stored.ciphertext ||
    !stored.iv
  ) {
    return conflict();
  }
  if (
    stored.targetConnectionId !==
      secretDecision.targetConnection.connectionId ||
    new URL(stored.targetUrl).host !== secretDecision.targetConnection.host
  ) {
    return conflict();
  }
  const envelopeScope = {
    organizationId,
    userId,
    connectorId: stored.connectorId,
    purpose: "mcp_static_token" as const,
  };
  const encrypted = { ciphertext: stored.ciphertext, iv: stored.iv };
  const compared = await Result.tryPromise(async () => {
    const credential = await decryptMcpSecret({
      ...envelopeScope,
      ...encrypted,
    });
    const saved =
      secretDecision.decision === "use-saved"
        ? await readSavedChatSecret({
            tx,
            organizationId,
            userId,
            connectorId: envelopeScope.connectorId,
            targetUrl: stored.targetUrl,
          })
        : undefined;
    if (secretDecision.decision === "use-saved" && !saved) {
      return false;
    }
    const submittedCredential =
      secretDecision.decision === "provide"
        ? secretDecision.value
        : saved && (await decryptMcpSecret({ ...envelopeScope, ...saved }));
    if (submittedCredential === undefined) {
      return false;
    }
    // Fixed-size digests permit a constant-time comparison for every input length.
    return timingSafeEqual(
      sha256Bytes(credential),
      sha256Bytes(submittedCredential),
    );
  });
  // Decryption failures carry no envelope or submitted value across this boundary.
  if (compared.isErr() || !compared.value) {
    return conflict();
  }
  return {
    kind: "receipt",
    receipt: { status: "provided", secretRef: stored.id, target },
  };
};
