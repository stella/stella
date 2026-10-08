import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";

import type { RequestSecretOutput } from "@stll/api-contract/chat-secret";
import { sha256Bytes } from "@stll/sha256/node";

import type { Transaction } from "@/api/db/root";
import { chatSecrets } from "@/api/db/schema";
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
    | { decision: "provide"; value: Secret<"StaticBearerToken"> }
    | { decision: "use-saved" }
    | { decision: "decline" };
};

const submissionConflict = () =>
  Result.err(
    new HandlerError({
      status: 409,
      code: "CHAT_PRIVATE_INPUT_ALREADY_SUBMITTED",
      message: "Private input was already submitted with a different decision",
    }),
  );

export const recoverChatSecretSubmission = async ({
  tx,
  organizationId,
  userId,
  threadId,
  toolCallId,
  secretDecision,
}: RecoverChatSecretOptions): Promise<
  Result<RequestSecretOutput | undefined, HandlerError>
> => {
  const readStored = () =>
    tx
      .select({
        id: chatSecrets.id,
        status: chatSecrets.decision,
        targetSlug: chatSecrets.targetSlug,
        targetUrl: chatSecrets.targetUrl,
        connectorId: chatSecrets.connectorId,
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
    return Result.ok(undefined);
  }
  await withAggregateLock({
    aggregate: "chatSecret",
    tx,
    id: { id: prior.id, organizationId, userId, threadId },
  });
  const stored = (await readStored()).at(0);
  if (!stored) {
    return Result.ok(undefined);
  }
  const target = {
    type: "mcp-connector" as const,
    connectorSlug: stored.targetSlug,
  };
  if (stored.status === "declined") {
    return secretDecision.decision === "decline"
      ? Result.ok({ status: "declined", target })
      : submissionConflict();
  }
  if (
    secretDecision.decision === "decline" ||
    !stored.connectorId ||
    !stored.ciphertext ||
    !stored.iv
  ) {
    return submissionConflict();
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
    return submissionConflict();
  }
  return Result.ok({ status: "provided", secretRef: stored.id, target });
};
