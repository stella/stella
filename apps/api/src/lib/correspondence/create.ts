import { panic } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";

import type {
  ParsedCorrespondence,
  CorrespondenceScanVerdict,
} from "@stll/api-contract/correspondence";
import { CORRESPONDENCE_MAX_ATTACHMENTS } from "@stll/api-contract/correspondence";
import { isOrganizationManagementRole } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { abortableTx } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
  correspondenceAttachments,
  correspondenceFilers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeEmailBodyHtml } from "@/api/lib/files/email-to-html";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

export type PreparedCorrespondenceAttachment = {
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
  filer:
    | { type: "user"; userId: SafeId<"user"> }
    | {
        type: "shared_mailbox";
        allowedSenderId: SafeId<"correspondenceAllowedSender">;
      };
  parsed: ParsedCorrespondence;
  attachments: PreparedCorrespondenceAttachment[];
  recordAuditEvent: AuditRecorder;
};

const MAX_CORRESPONDENCE_BODY_CHARS = 2_000_000;

type ValidateContentOptions = Pick<
  CreateCorrespondenceOptions,
  "parsed" | "attachments"
>;

const validateContent = ({ parsed, attachments }: ValidateContentOptions) => {
  if (
    !/^[0-9a-f]{64}$/u.test(parsed.contentHash) ||
    parsed.authentication.dmarc !== "pass" ||
    (parsed.authentication.spf !== "pass" &&
      parsed.authentication.dkim !== "pass")
  ) {
    return { type: "invalid_authentication" as const };
  }
  if (
    attachments.length > CORRESPONDENCE_MAX_ATTACHMENTS ||
    parsed.bodyText.length > MAX_CORRESPONDENCE_BODY_CHARS ||
    (parsed.bodyHtml !== null &&
      parsed.bodyHtml.length > MAX_CORRESPONDENCE_BODY_CHARS) ||
    attachments.some(
      (attachment) =>
        attachment.scanVerdict !== "clean" || attachment.byteSize < 0,
    )
  ) {
    return { type: "invalid_content" as const };
  }
  return null;
};

export const correspondenceDedupKey = ({
  messageId,
  contentHash,
}: Pick<ParsedCorrespondence, "messageId" | "contentHash">) =>
  createHash("sha256")
    .update(
      JSON.stringify([messageId?.trim().toLowerCase() ?? null, contentHash]),
    )
    .digest("hex");

type AuthorizeFilerOptions = Pick<
  CreateCorrespondenceOptions,
  "filer" | "workspaceId" | "organizationId"
> & { tx: Transaction };

const authorizeFiler = async ({
  tx,
  filer,
  workspaceId,
  organizationId,
}: AuthorizeFilerOptions) => {
  switch (filer.type) {
    case "user": {
      const [access] = await tx
        .select({
          role: member.role,
          clientId: workspaces.clientId,
          assignedUserId: workspaceMembers.userId,
        })
        .from(workspaces)
        .innerJoin(
          member,
          and(
            eq(member.organizationId, workspaces.organizationId),
            eq(member.userId, filer.userId),
          ),
        )
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, workspaces.id),
            eq(workspaceMembers.userId, filer.userId),
          ),
        )
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (
        access === undefined ||
        (access.assignedUserId === null &&
          !(
            access.clientId !== null &&
            isOrganizationManagementRole(access.role)
          ))
      ) {
        throw new HandlerError({
          status: 403,
          message: "Matter access required",
        });
      }
      break;
    }
    case "shared_mailbox": {
      const [approval] = await tx
        .select({ scope: correspondenceAllowedSenders.scope })
        .from(correspondenceAllowedSenders)
        .where(
          and(
            eq(correspondenceAllowedSenders.id, filer.allowedSenderId),
            eq(correspondenceAllowedSenders.organizationId, organizationId),
            eq(correspondenceAllowedSenders.kind, "shared_mailbox"),
            isNull(correspondenceAllowedSenders.revokedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (approval === undefined) {
        throw new HandlerError({
          status: 403,
          message: "Mailbox approval required",
        });
      }
      if (approval.scope === "matters") {
        const [scope] = await tx
          .select({ id: correspondenceAllowedSenderMatters.id })
          .from(correspondenceAllowedSenderMatters)
          .where(
            and(
              eq(
                correspondenceAllowedSenderMatters.allowedSenderId,
                filer.allowedSenderId,
              ),
              eq(correspondenceAllowedSenderMatters.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (scope === undefined) {
          throw new HandlerError({
            status: 403,
            message: "Mailbox not approved for matter",
          });
        }
      }
      break;
    }
    default: {
      filer satisfies never;
      return panic("Unhandled correspondence filer");
    }
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
    await authorizeFiler({ tx, filer, workspaceId, organizationId });

    const dedupKey = correspondenceDedupKey(parsed);
    const inserted = await tx
      .insert(correspondence)
      .values({
        organizationId,
        workspaceId,
        direction: parsed.direction,
        channel: parsed.channel,
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
        spf: parsed.authentication.spf,
        dkim: parsed.authentication.dkim,
        dmarc: parsed.authentication.dmarc,
        alignedIdentifier: parsed.authentication.alignedIdentifier,
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
      throw new HandlerError({
        status: 500,
        message: "Correspondence write failed",
      });
    }

    const filers = await tx
      .insert(correspondenceFilers)
      .values({
        organizationId,
        workspaceId,
        correspondenceId,
        filedByUserId: filer.type === "user" ? filer.userId : null,
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
    return {
      type: "ok" as const,
      id: correspondenceId,
      created: created !== undefined,
      filerAdded: filers.length > 0,
    };
  });
  return transaction.isErr()
    ? { type: "error" as const, error: transaction.error }
    : transaction.value;
};
