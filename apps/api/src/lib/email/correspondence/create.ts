import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type {
  CorrespondenceScanVerdict,
  ParsedCorrespondence,
} from "@stll/api-contract/correspondence";
import {
  CORRESPONDENCE_MAX_ATTACHMENTS,
  CORRESPONDENCE_MAX_BODY_CHARACTERS,
} from "@stll/api-contract/correspondence";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { abortableTx } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
  correspondenceSources,
  entities,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import {
  assertCorrespondenceAccess,
  type CorrespondenceActor,
} from "@/api/lib/email/correspondence/access";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

import {
  persistCorrespondenceContent,
  prepareCorrespondenceContent,
} from "./uploaded-content";

type RetireCorrespondenceSourceOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  sourceEntityId: SafeId<"entity">;
  expectedSourceVersionId: SafeId<"entityVersion"> | null;
  recordAuditEvent: AuditRecorder;
};

/** Fences a retired generation without discarding its correspondence history. */
export const retireCorrespondenceSource = async ({
  safeDb,
  organizationId,
  workspaceId,
  sourceEntityId,
  expectedSourceVersionId,
  recordAuditEvent,
}: RetireCorrespondenceSourceOptions) => {
  const transaction = await abortableTx(safeDb, async (tx) => {
    const [linked] = await tx
      .select({ id: correspondenceSources.correspondenceId })
      .from(correspondenceSources)
      .where(
        and(
          eq(correspondenceSources.organizationId, organizationId),
          eq(correspondenceSources.workspaceId, workspaceId),
          eq(correspondenceSources.entityId, sourceEntityId),
        ),
      )
      .unionAll(
        tx
          .select({ id: correspondence.id })
          .from(correspondence)
          .where(
            and(
              eq(correspondence.organizationId, organizationId),
              eq(correspondence.workspaceId, workspaceId),
              eq(correspondence.sourceEntityId, sourceEntityId),
            ),
          ),
      )
      .limit(1);
    // Filing an older generation is fenced by the immutable source version;
    // ordinary files without a correspondence link need no aggregate locks.
    if (linked === undefined) {
      return Result.ok({ type: "ok" as const });
    }
    const matter = await withAggregateLock({
      tx,
      aggregate: "workspace",
      id: { id: workspaceId, organizationId },
      mode: "update",
    });
    switch (matter.status) {
      case "missing":
        return Result.ok({ type: "source_changed" as const });
      case "busy":
        return Result.err(matter.error);
      case "locked":
        break;
      default:
        matter satisfies never;
        return panic("Unhandled matter lock");
    }
    const source = await withAggregateLock({
      tx,
      aggregate: "entity",
      id: { id: sourceEntityId, workspaceId },
      mode: "share",
    });
    switch (source.status) {
      case "missing":
        return Result.ok({ type: "source_changed" as const });
      case "busy":
        return Result.err(source.error);
      case "locked":
        break;
      default:
        source satisfies never;
        return panic("Unhandled source lock");
    }
    const [current] = await tx
      .select({ versionId: entities.currentVersionId })
      .from(entities)
      .where(
        and(
          eq(entities.id, sourceEntityId),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (current?.versionId !== expectedSourceVersionId) {
      return Result.ok({ type: "source_changed" as const });
    }
    const [previous] = await tx
      .select({ id: correspondence.id })
      .from(correspondence)
      .where(
        and(
          eq(correspondence.workspaceId, workspaceId),
          eq(correspondence.sourceEntityId, sourceEntityId),
        ),
      )
      .limit(1);
    const [associated] = await tx
      .select({ id: correspondenceSources.correspondenceId })
      .from(correspondenceSources)
      .where(
        and(
          eq(correspondenceSources.workspaceId, workspaceId),
          eq(correspondenceSources.entityId, sourceEntityId),
        ),
      )
      .limit(1);
    const id = associated?.id ?? previous?.id;
    if (id !== undefined) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
        resourceId: id,
        workspaceId,
        metadata: { sourceRetired: true },
      });
    }
    return Result.ok({ type: "ok" as const });
  });
  const result = transaction.andThen((value) => value);
  return result.isErr()
    ? { type: "error" as const, error: result.error }
    : result.value;
};

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
  expectedSourceVersionId?: SafeId<"entityVersion"> | null;
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

// A data-box message is only ever read from an uploaded file, and its record
// keeps the envelope's message ID.
const hasConsistentChannel = (parsed: ParsedCorrespondence) => {
  switch (parsed.channel) {
    case "email":
      return true;
    case "data_box":
      return (
        parsed.source === "upload" &&
        parsed.messageId === parsed.dataBox.messageId
      );
    default:
      parsed satisfies never;
      return panic("Unhandled correspondence channel");
  }
};

const validateContent = ({ parsed, attachments }: ValidateContentOptions) => {
  if (
    !/^[0-9a-f]{64}$/u.test(parsed.contentHash) ||
    !hasAdmissibleProvenance(parsed)
  ) {
    return { type: "invalid_authentication" as const };
  }
  if (!hasConsistentChannel(parsed)) {
    return { type: "invalid_content" as const };
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

/** Converges concurrent deliveries on one record and one row per filer. */
export const createCorrespondence = async ({
  expectedSourceVersionId = null,
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

    if (parsed.source === "upload") {
      // Hold the copy before touching the record: entity deletion must not
      // race a deduplicated upload into attaching a disappearing source.
      const source = await withAggregateLock({
        tx,
        aggregate: "entity",
        id: { id: parsed.sourceEntityId, workspaceId },
        mode: "share",
      });
      switch (source.status) {
        case "locked":
          break;
        case "missing":
          return Result.ok({ type: "invalid_content" as const });
        case "busy":
          return Result.err(source.error);
        default:
          source satisfies never;
          return panic("Unhandled correspondence source lock");
      }
      const [current] = await tx
        .select({ versionId: entities.currentVersionId })
        .from(entities)
        .where(
          and(
            eq(entities.id, parsed.sourceEntityId),
            eq(entities.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (current?.versionId !== expectedSourceVersionId) {
        return Result.ok({ type: "source_changed" as const });
      }
    }
    const persisted = await persistCorrespondenceContent({
      tx,
      organizationId,
      workspaceId,
      content: prepareCorrespondenceContent(parsed),
      recordAuditEvent,
    });
    if (persisted.isErr()) {
      return persisted;
    }
    const { id: correspondenceId, status } = persisted.value;
    const created = status === "created";
    const refreshed = status === "refreshed";

    const sources =
      parsed.source === "upload"
        ? await tx
            .insert(correspondenceSources)
            .values({
              organizationId,
              workspaceId,
              correspondenceId,
              entityId: parsed.sourceEntityId,
            })
            .onConflictDoNothing()
            .returning({ entityId: correspondenceSources.entityId })
        : [];

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

    if (created || refreshed) {
      await linkAttachments({
        tx,
        organizationId,
        workspaceId,
        correspondenceId,
        attachments,
      });
    }

    if (!created && !refreshed && (filers.length > 0 || sources.length > 0)) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
        resourceId: correspondenceId,
        workspaceId,
        metadata: { subject: parsed.subject, sourceAdded: sources.length > 0 },
      });
    }
    return Result.ok({
      type: "ok" as const,
      id: correspondenceId,
      created,
      filerAdded: filers.length > 0,
    });
  });
  const result = transaction.andThen((value) => value);
  return result.isErr()
    ? { type: "error" as const, error: result.error }
    : result.value;
};
