import { Result } from "better-result";
import * as v from "valibot";

import {
  OUTBOUND_ACTION_TTL_MS,
  outboundActionPreviewSchema,
  type OutboundActionPreview,
} from "@stll/api-contract/outbound-action";

import type { Transaction } from "@/api/db/root";
import { outboundActions } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { outboundPreviewHash } from "@/api/lib/outbound-actions/preview";

/**
 * Store what the assistant prepared as a pending action. Nothing is sent:
 * only the user's confirm of this exact preview executes it.
 */
export const prepareOutboundAction = async ({
  chatThreadId,
  now,
  organizationId,
  preview,
  recordAuditEvent,
  tx,
  userId,
}: {
  chatThreadId: SafeId<"chatThread">;
  now: Date;
  organizationId: SafeId<"organization">;
  preview: OutboundActionPreview;
  recordAuditEvent: AuditRecorder;
  tx: Transaction;
  userId: SafeId<"user">;
}): Promise<
  Result<{ id: SafeId<"outboundAction">; previewHash: string }, HandlerError>
> => {
  const parsed = v.safeParse(outboundActionPreviewSchema, preview);
  if (!parsed.success) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "The prepared action is not valid",
      }),
    );
  }
  const previewHash = outboundPreviewHash(parsed.output);
  const encrypted = await encryptContent(
    organizationId,
    JSON.stringify(parsed.output),
  );
  const inserted = await tx
    .insert(outboundActions)
    .values({
      organizationId,
      userId,
      chatThreadId,
      kind: parsed.output.kind,
      status: "pending",
      previewEncrypted: encrypted.ciphertext,
      previewIv: encrypted.iv,
      previewHash,
      expiresAt: new Date(now.getTime() + OUTBOUND_ACTION_TTL_MS),
    })
    .returning({ id: outboundActions.id });
  const row = inserted.at(0);
  if (!row) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Could not prepare the action",
      }),
    );
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.OUTBOUND_ACTION,
    resourceId: row.id,
    workspaceId: null,
    metadata: {
      chatThreadId,
      kind: parsed.output.kind,
      operation: "prepare",
      previewHash,
    },
  });
  return Result.ok({ id: row.id, previewHash });
};

/**
 * Decrypt a stored preview and check it still hashes to the stored hash, so
 * what executes is exactly what the confirm was bound to.
 */
export const readStoredOutboundPreview = async ({
  organizationId,
  previewEncrypted,
  previewHash,
  previewIv,
}: {
  organizationId: SafeId<"organization">;
  previewEncrypted: Buffer;
  previewHash: string;
  previewIv: Buffer;
}): Promise<Result<OutboundActionPreview, HandlerError>> => {
  const decrypted = await Result.tryPromise({
    try: async () =>
      await decryptContent(organizationId, previewEncrypted, previewIv),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not read the prepared action",
        cause,
      }),
  });
  if (Result.isError(decrypted)) {
    return Result.err(decrypted.error);
  }
  const parsed = v.safeParse(
    outboundActionPreviewSchema,
    Result.try((): unknown => JSON.parse(decrypted.value)).unwrapOr(null),
  );
  if (!parsed.success || outboundPreviewHash(parsed.output) !== previewHash) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "The prepared action does not match its preview",
      }),
    );
  }
  return Result.ok(parsed.output);
};
