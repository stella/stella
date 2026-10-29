import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

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
import { executedRows } from "@/api/lib/db/executed-rows";
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

type FindSourceContentOptions = Pick<
  PersistContentOptions,
  "organizationId" | "workspaceId" | "content"
> & { tx: Pick<Transaction, "select"> };

const findSourceContent = async ({
  tx,
  organizationId,
  workspaceId,
  content,
}: FindSourceContentOptions) =>
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

type SourceLifetimeReadOptions = {
  tx: Pick<Transaction, "execute">;
  workspaceId: SafeId<"workspace">;
  sourceEntityId: SafeId<"entity">;
};

const sourceHasOtherCopies = async ({
  tx,
  workspaceId,
  sourceEntityId,
}: SourceLifetimeReadOptions) => {
  const rows = executedRows(
    await tx.execute(sql`
      SELECT public.correspondence_has_other_sources(${workspaceId}, ${sourceEntityId}) AS has_other_sources
    `),
  );
  return v.parse(
    v.object({ has_other_sources: v.nullable(v.boolean()) }),
    rows.at(0),
  ).has_other_sources;
};

type PlanContentOptions = FindSourceContentOptions & {
  readSourceLifetime: () => Promise<boolean | null>;
};

/** Only reads are available until the entire filing target is admitted. */
const planCorrespondenceContent = async (options: PlanContentOptions) => {
  const { tx, organizationId, workspaceId, content } = options;
  const [previous] = await findSourceContent(options);
  const [target] = await tx
    .select({ id: correspondence.id, contentHash: correspondence.contentHash })
    .from(correspondence)
    .where(
      and(
        eq(correspondence.organizationId, organizationId),
        eq(correspondence.workspaceId, workspaceId),
        eq(correspondence.dedupKey, content.dedupKey),
      ),
    )
    .limit(1);
  if (
    target !== undefined &&
    target.id !== previous?.id &&
    target.contentHash !== content.contentHash
  ) {
    return Result.ok({ type: "invalid_content" as const });
  }
  const hasOtherSources =
    previous !== undefined &&
    content.sourceEntityId !== null &&
    (previous.contentHash !== content.contentHash ||
      previous.dedupKey !== content.dedupKey)
      ? await options.readSourceLifetime()
      : false;
  if (hasOtherSources === null) {
    return Result.ok({ type: "invalid_content" as const });
  }
  if (
    previous !== undefined &&
    hasOtherSources &&
    previous.dedupKey === content.dedupKey &&
    previous.contentHash !== content.contentHash
  ) {
    return Result.ok({ type: "invalid_content" as const });
  }
  if (
    previous !== undefined &&
    !hasOtherSources &&
    target !== undefined &&
    target.id !== previous.id
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        message:
          "The source update conflicts with another correspondence record",
      }),
    );
  }
  return Result.ok({
    type: "ready" as const,
    previous,
    target,
    hasOtherSources,
  });
};

/** The caller holds the matter and current source generation through this write. */
export const persistCorrespondenceContent = async ({
  tx,
  organizationId,
  workspaceId,
  content,
  recordAuditEvent,
}: PersistContentOptions) => {
  const planned = await planCorrespondenceContent({
    tx,
    organizationId,
    workspaceId,
    content,
    readSourceLifetime: async () => {
      if (content.sourceEntityId === null) {
        return panic("A delivered message has no uploaded source lifetime");
      }
      return await sourceHasOtherCopies({
        tx,
        workspaceId,
        sourceEntityId: content.sourceEntityId,
      });
    },
  });
  if (planned.isErr()) {
    return Result.err(planned.error);
  }
  const plan = planned.value;
  if (plan.type === "invalid_content") {
    return Result.ok({ status: "invalid_content" as const });
  }
  let previous = plan.previous;
  if (
    previous !== undefined &&
    plan.hasOtherSources &&
    content.sourceEntityId !== null
  ) {
    // The remaining copies still own their original message and workflow.
    // Admission above also checked a matching target before this unlink.
    await tx
      .delete(correspondenceSources)
      .where(
        and(
          eq(correspondenceSources.organizationId, organizationId),
          eq(correspondenceSources.workspaceId, workspaceId),
          eq(correspondenceSources.correspondenceId, previous.id),
          eq(correspondenceSources.entityId, content.sourceEntityId),
        ),
      );
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
      resourceId: previous.id,
      workspaceId,
      metadata: { sourceRemoved: true },
    });
    previous = undefined;
  }
  if (previous !== undefined) {
    const refreshed =
      previous.contentHash !== content.contentHash ||
      previous.dedupKey !== content.dedupKey;
    if (refreshed) {
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
      contentHash: content.contentHash,
      status: refreshed ? ("refreshed" as const) : ("existing" as const),
    });
  }
  if (plan.target !== undefined) {
    return Result.ok({
      id: plan.target.id,
      contentHash: plan.target.contentHash,
      status: "existing" as const,
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
    return Result.ok({
      id: inserted.id,
      contentHash: content.contentHash,
      status: "created" as const,
    });
  }
  return panic("Correspondence insert returned no record");
};
