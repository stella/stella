import { panic, Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceSources,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeEmailBodyHtml } from "@/api/lib/files/email-to-html";

// The system issues a data-box message ID once, so every file of one message
// converges on one record in the matter.
//
// For email, the source is part of the key: a delivered message and an
// uploaded file of the same message stay separate records. Each email file is
// its own record, so deleting one copy never removes another file's record.
const correspondenceDedupKey = (parsed: ParsedCorrespondence) => {
  if (parsed.channel === "data_box") {
    return hashSha256Hex(
      JSON.stringify([parsed.channel, parsed.dataBox.messageId]),
    );
  }
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

type DerivedContent = Omit<
  typeof correspondence.$inferSelect,
  | "id"
  | "organizationId"
  | "workspaceId"
  | "entityFeatureGate"
  | "handlingState"
  | "assigneeId"
  | "createdAt"
  | "updatedAt"
>;

/** Explicitly excludes workflow state, filing history and record identity. */
export const prepareCorrespondenceContent = (parsed: ParsedCorrespondence) =>
  ({
    direction: parsed.direction,
    channel: parsed.channel,
    ...provenanceColumns(parsed),
    messageId: parsed.messageId,
    dataBox: parsed.dataBox,
    contentHash: parsed.contentHash,
    dedupKey: correspondenceDedupKey(parsed),
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
      parsed.bodyHtml === null ? null : sanitizeEmailBodyHtml(parsed.bodyHtml),
  }) satisfies DerivedContent;

type PersistContentOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  content: ReturnType<typeof prepareCorrespondenceContent>;
  recordAuditEvent: AuditRecorder;
};

/** The caller holds the matter and current source generation through this write. */
export const persistCorrespondenceContent = async ({
  tx,
  organizationId,
  workspaceId,
  content,
  recordAuditEvent,
}: PersistContentOptions) => {
  const [previous] =
    content.sourceEntityId === null
      ? []
      : await tx
          .select({
            id: correspondence.id,
            contentHash: correspondence.contentHash,
            dedupKey: correspondence.dedupKey,
          })
          .from(correspondenceSources)
          .innerJoin(
            correspondence,
            and(
              eq(correspondence.id, correspondenceSources.correspondenceId),
              eq(correspondence.workspaceId, correspondenceSources.workspaceId),
              eq(
                correspondence.organizationId,
                correspondenceSources.organizationId,
              ),
            ),
          )
          .where(
            and(
              eq(correspondenceSources.organizationId, organizationId),
              eq(correspondenceSources.workspaceId, workspaceId),
              eq(correspondenceSources.entityId, content.sourceEntityId),
            ),
          )
          .unionAll(
            tx
              .select({
                id: correspondence.id,
                contentHash: correspondence.contentHash,
                dedupKey: correspondence.dedupKey,
              })
              .from(correspondence)
              .where(
                and(
                  eq(correspondence.organizationId, organizationId),
                  eq(correspondence.workspaceId, workspaceId),
                  eq(correspondence.sourceEntityId, content.sourceEntityId),
                ),
              ),
          )
          .limit(1);
  if (previous !== undefined) {
    const refreshed =
      previous.contentHash !== content.contentHash ||
      previous.dedupKey !== content.dedupKey;
    if (refreshed) {
      const [collision] = await tx
        .select({ id: correspondence.id })
        .from(correspondence)
        .where(
          and(
            eq(correspondence.workspaceId, workspaceId),
            eq(correspondence.dedupKey, content.dedupKey),
            ne(correspondence.id, previous.id),
          ),
        )
        .limit(1);
      if (collision !== undefined) {
        return Result.err(
          new HandlerError({
            status: 409,
            message:
              "The source update conflicts with another correspondence record",
          }),
        );
      }
      await tx
        .update(correspondence)
        .set({
          direction: content.direction,
          channel: content.channel,
          source: content.source,
          sourceEntityId: content.sourceEntityId,
          intake: content.intake,
          authenticatedSenderAddress: content.authenticatedSenderAddress,
          originalSignature: content.originalSignature,
          messageId: content.messageId,
          dataBox: content.dataBox,
          contentHash: content.contentHash,
          dedupKey: content.dedupKey,
          from: content.from,
          to: content.to,
          cc: content.cc,
          subject: content.subject,
          sentAt: content.sentAt,
          receivedAt: content.receivedAt,
          inReplyTo: content.inReplyTo,
          references: content.references,
          bodyText: content.bodyText,
          bodyHtml: content.bodyHtml,
          spf: content.spf,
          dkim: content.dkim,
          dmarc: content.dmarc,
          alignedIdentifier: content.alignedIdentifier,
          updatedAt: new Date(),
        } satisfies DerivedContent & { updatedAt: Date })
        .where(
          and(
            eq(correspondence.id, previous.id),
            eq(correspondence.workspaceId, workspaceId),
            eq(correspondence.organizationId, organizationId),
          ),
        );
      // These links describe the parsed generation; the matter documents and
      // their user-authored metadata/annotations remain independent entities.
      await tx
        .delete(correspondenceAttachments)
        .where(
          and(
            eq(correspondenceAttachments.correspondenceId, previous.id),
            eq(correspondenceAttachments.workspaceId, workspaceId),
            eq(correspondenceAttachments.organizationId, organizationId),
          ),
        );
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
        resourceId: previous.id,
        workspaceId,
        metadata: { subject: content.subject, contentRefreshed: true },
      });
    }
    return Result.ok({
      id: previous.id,
      status: refreshed ? ("refreshed" as const) : ("existing" as const),
    });
  }
  const [inserted] = await tx
    .insert(correspondence)
    .values({ ...content, organizationId, workspaceId })
    .onConflictDoNothing({
      target: [correspondence.workspaceId, correspondence.dedupKey],
    })
    .returning({ id: correspondence.id });
  if (inserted !== undefined) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
      resourceId: inserted.id,
      workspaceId,
      metadata: { subject: content.subject },
    });
    return Result.ok({ id: inserted.id, status: "created" as const });
  }
  const [existing] = await tx
    .select({ id: correspondence.id })
    .from(correspondence)
    .where(
      and(
        eq(correspondence.workspaceId, workspaceId),
        eq(correspondence.dedupKey, content.dedupKey),
      ),
    )
    .limit(1);
  if (existing === undefined) {
    return panic("Correspondence insert has no conflicting record");
  }
  return Result.ok({ id: existing.id, status: "existing" as const });
};
