import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type {
  ParsedCorrespondence,
  CorrespondenceScanVerdict,
} from "@stll/api-contract/correspondence";
import {
  CORRESPONDENCE_MAX_ATTACHMENTS,
  CORRESPONDENCE_MAX_BODY_CHARACTERS,
} from "@stll/api-contract/correspondence";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { abortableTx } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  assertCorrespondenceAccess,
  type CorrespondenceActor,
} from "@/api/lib/email/correspondence/access";
import { sanitizeEmailBodyHtml } from "@/api/lib/files/email-to-html";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

type PreparedCorrespondenceAttachment = {
  entityId: SafeId<"entity">;
  filename: string;
  mediaType: string;
  byteSize: number;
  scanVerdict: CorrespondenceScanVerdict;
};

type LinkAttachmentsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  correspondenceId: SafeId<"correspondence">;
  attachments: PreparedCorrespondenceAttachment[];
};

const linkAttachments = async ({
  tx,
  organizationId,
  workspaceId,
  correspondenceId,
  attachments,
}: LinkAttachmentsOptions) => {
  if (attachments.length === 0) {
    return;
  }
  await tx.insert(correspondenceAttachments).values(
    attachments.map((attachment, ordinal) => ({
      organizationId,
      workspaceId,
      correspondenceId,
      entityId: attachment.entityId,
      ordinal,
      filename: sanitizeFilename(attachment.filename),
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize,
      scanVerdict: attachment.scanVerdict,
    })),
  );
};

type CreateCorrespondenceOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  filer: CorrespondenceActor;
  parsed: ParsedCorrespondence;
  attachments: PreparedCorrespondenceAttachment[];
  recordAuditEvent: AuditRecorder;
};

type ValidateContentOptions = Pick<
  CreateCorrespondenceOptions,
  "parsed" | "attachments"
>;

// An upload is not a delivery: its uploader's matter access, rechecked in the
// filing transaction, admits it instead of transport authentication.
const hasAdmissibleProvenance = (parsed: ParsedCorrespondence) => {
  switch (parsed.source) {
    case "delivery":
      return (
        parsed.authenticatedSender.dmarc === "pass" &&
        (parsed.authenticatedSender.spf === "pass" ||
          parsed.authenticatedSender.dkim === "pass")
      );
    case "upload":
      return true;
    default:
      parsed satisfies never;
      return panic("Unhandled correspondence source");
  }
};

const validateContent = ({ parsed, attachments }: ValidateContentOptions) => {
  if (
    !/^[0-9a-f]{64}$/u.test(parsed.contentHash) ||
    !hasAdmissibleProvenance(parsed)
  ) {
    return { type: "invalid_authentication" as const };
  }
  if (
    attachments.length > CORRESPONDENCE_MAX_ATTACHMENTS ||
    parsed.bodyText.length > CORRESPONDENCE_MAX_BODY_CHARACTERS ||
    (parsed.bodyHtml !== null &&
      parsed.bodyHtml.length > CORRESPONDENCE_MAX_BODY_CHARACTERS) ||
    attachments.some(
      (attachment) =>
        attachment.scanVerdict !== "clean" || attachment.byteSize < 0,
    )
  ) {
    return { type: "invalid_content" as const };
  }
  return null;
};

// The source is part of the key: a delivered message and an uploaded file of
// the same message stay separate records. Each email file is its own record,
// so deleting one copy never removes another file's record.
const correspondenceDedupKey = (parsed: ParsedCorrespondence) => {
  switch (parsed.source) {
    case "delivery":
      return hashSha256Hex(
        JSON.stringify([
          parsed.intake,
          parsed.messageId?.trim() ?? null,
          parsed.contentHash,
        ]),
      );
    case "upload":
      return hashSha256Hex(
        JSON.stringify([parsed.source, parsed.sourceEntityId]),
      );
    default:
      parsed satisfies never;
      return panic("Unhandled correspondence source");
  }
};

const provenanceColumns = (parsed: ParsedCorrespondence) => {
  switch (parsed.source) {
    case "delivery":
      return {
        source: parsed.source,
        sourceEntityId: null,
        intake: parsed.intake,
        authenticatedSenderAddress: parsed.authenticatedSender.address,
        originalSignature: parsed.originalSignature,
        spf: parsed.authenticatedSender.spf,
        dkim: parsed.authenticatedSender.dkim,
        dmarc: parsed.authenticatedSender.dmarc,
        alignedIdentifier: parsed.authenticatedSender.alignedIdentifier,
      };
    case "upload":
      return {
        source: parsed.source,
        sourceEntityId: parsed.sourceEntityId,
        intake: null,
        authenticatedSenderAddress: null,
        originalSignature: parsed.originalSignature,
        spf: null,
        dkim: null,
        dmarc: null,
        alignedIdentifier: null,
      };
    default:
      parsed satisfies never;
      return panic("Unhandled correspondence source");
  }
};

/** Converges concurrent deliveries on one record and one row per filer. */
export const createCorrespondence = async ({
  safeDb,
  workspaceId,
  organizationId,
  filer,
  parsed,
  attachments,
  recordAuditEvent,
}: CreateCorrespondenceOptions) => {
  const invalid = validateContent({ parsed, attachments });
  if (invalid !== null) {
    return invalid;
  }

  const transaction = await abortableTx(safeDb, async (tx) => {
    const access = await assertCorrespondenceAccess({
      tx,
      filer,
      workspaceId,
      organizationId,
    });
    if (access.isErr()) {
      return access;
    }

    const dedupKey = correspondenceDedupKey(parsed);
    const inserted = await tx
      .insert(correspondence)
      .values({
        organizationId,
        workspaceId,
        direction: parsed.direction,
        channel: parsed.channel,
        ...provenanceColumns(parsed),
        messageId: parsed.messageId,
        contentHash: parsed.contentHash,
        dedupKey,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        sentAt: parsed.sentAt === null ? null : new Date(parsed.sentAt),
        receivedAt: new Date(parsed.receivedAt),
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        bodyText: parsed.bodyText,
        bodyHtml:
          parsed.bodyHtml === null
            ? null
            : sanitizeEmailBodyHtml(parsed.bodyHtml),
      })
      .onConflictDoNothing({
        target: [correspondence.workspaceId, correspondence.dedupKey],
      })
      .returning({ id: correspondence.id });
    const created = inserted.at(0);
    const existing =
      created === undefined
        ? await tx
            .select({ id: correspondence.id })
            .from(correspondence)
            .where(
              and(
                eq(correspondence.workspaceId, workspaceId),
                eq(correspondence.dedupKey, dedupKey),
              ),
            )
            .limit(1)
        : [];
    const correspondenceId = created?.id ?? existing.at(0)?.id;
    if (correspondenceId === undefined) {
      return tx.rollback();
    }

    const filers = await tx
      .insert(correspondenceFilers)
      .values({
        organizationId,
        workspaceId,
        correspondenceId,
        filedByUserId: filer.type === "user" ? filer.userId : null,
        filedByDisplay: access.value,
        filedByAllowedSenderId:
          filer.type === "shared_mailbox" ? filer.allowedSenderId : null,
      })
      .onConflictDoNothing()
      .returning({ id: correspondenceFilers.id });

    if (created !== undefined) {
      await linkAttachments({
        tx,
        organizationId,
        workspaceId,
        correspondenceId,
        attachments,
      });
    }

    if (created !== undefined || filers.length > 0) {
      await recordAuditEvent(tx, {
        action:
          created !== undefined ? AUDIT_ACTION.CREATE : AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
        resourceId: correspondenceId,
        workspaceId,
        metadata: { subject: parsed.subject },
      });
    }
    return Result.ok({
      type: "ok" as const,
      id: correspondenceId,
      created: created !== undefined,
      filerAdded: filers.length > 0,
    });
  });
  const result = transaction.andThen((value) => value);
  return result.isErr()
    ? { type: "error" as const, error: result.error }
    : result.value;
};
