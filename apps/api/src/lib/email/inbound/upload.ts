import { panic, Result, TaggedError } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import type { CorrespondenceOriginalSignature } from "@stll/api-contract/correspondence";
import {
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
  type EMAIL_MIME_TYPES,
} from "@stll/api-contract/email-mime-types";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped, type ScopedDb } from "@/api/db/safe-db";
import { correspondenceAttachments, entities } from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { verifyOriginalSignature } from "@/api/lib/email/inbound/authentication";
import { PARSE_DROP_REASON } from "@/api/lib/email/inbound/ingest";
import {
  correspondenceFromMessage,
  parseEmailFile,
  type EmailFileFormat,
} from "@/api/lib/email/inbound/message";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const UPLOADED_MAIL_FORMATS = {
  [EML_MIME_TYPE]: "eml",
  [MSG_MIME_TYPE]: "msg",
} as const satisfies Record<keyof typeof EMAIL_MIME_TYPES, EmailFileFormat>;

const isUploadedMailMimeType = (
  mimeType: string,
): mimeType is keyof typeof UPLOADED_MAIL_FORMATS =>
  Object.hasOwn(UPLOADED_MAIL_FORMATS, mimeType);

const UNVERIFIED_SIGNATURE = {
  status: "unverified",
} as const satisfies CorrespondenceOriginalSignature;

type UploadedMailSkipReason =
  | "not_email"
  | "source_missing"
  | "no_uploader"
  | "correspondence_attachment"
  | (typeof PARSE_DROP_REASON)[keyof typeof PARSE_DROP_REASON]
  | "no_sender"
  | "no_matter_access"
  | "invalid_content";

/** Terminal outcomes: a permanent refusal is a skip, never an error. */
type UploadedMailOutcome =
  | {
      status: "filed" | "duplicate";
      correspondenceId: SafeId<"correspondence">;
    }
  | { status: "skipped"; reason: UploadedMailSkipReason };

/**
 * The database could not be reached or a statement failed. Nothing was
 * committed for the file, so the same input can be filed again later.
 */
export class UploadedMailUnavailableError extends TaggedError(
  "UploadedMailUnavailableError",
)<{
  message: string;
  cause?: unknown;
}> {}

const unavailable = (cause: unknown) =>
  new UploadedMailUnavailableError({
    message: "Uploaded correspondence could not be filed",
    cause,
  });

type UploadedMailScope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
};

type UploaderScope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
};

type FileUploadedMailOptions = {
  bytes: ArrayBuffer;
  mimeType: string;
  scope: UploadedMailScope;
  /** The filing job's connection; it reads only the file's uploader. */
  database: {
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  };
  scopedDbForUploader?: (scope: UploaderScope) => ScopedDb;
  verifyOriginal?: typeof verifyOriginalSignature;
};

const scopedDbForUploaderDefault = ({
  organizationId,
  workspaceId,
  userId,
}: UploaderScope) =>
  createRootScopedDb({ organizationId, userId, workspaceIds: [workspaceId] });

// The uploader's address is read only through their membership of the file's
// organization; a former member reads as no uploader.
const readUploader = async (
  database: FileUploadedMailOptions["database"],
  { entityId, workspaceId, organizationId }: UploadedMailScope,
) =>
  await database.transaction(async (tx) => {
    const [file] = await tx
      .select({
        createdBy: entities.createdBy,
        createdAt: entities.createdAt,
        uploaderEmail: user.email,
      })
      .from(entities)
      .leftJoin(
        member,
        and(
          eq(member.userId, entities.createdBy),
          eq(member.organizationId, organizationId),
        ),
      )
      .leftJoin(user, and(eq(user.id, member.userId), isNull(user.deletedAt)))
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      )
      .limit(1);
    return file ?? null;
  });

// An inbound attachment is part of its delivered record, not an upload.
const isCorrespondenceAttachment = async (
  scopedDb: ScopedDb,
  { entityId, workspaceId }: UploadedMailScope,
) =>
  await scopedDb(async (tx) => {
    const links = await tx
      .select({ id: correspondenceAttachments.id })
      .from(correspondenceAttachments)
      .where(
        and(
          eq(correspondenceAttachments.workspaceId, workspaceId),
          eq(correspondenceAttachments.entityId, entityId),
        ),
      )
      .limit(1);
    return links.length > 0;
  });

// The file's own DKIM signature is optional provenance, checked exactly like
// an attached original; proof that cannot be established stays unverified.
const uploadedSignature = async ({
  bytes,
  format,
  verifyOriginal,
}: {
  bytes: ArrayBuffer;
  format: EmailFileFormat;
  verifyOriginal: typeof verifyOriginalSignature;
}): Promise<CorrespondenceOriginalSignature> => {
  switch (format) {
    case "eml": {
      const verified = await verifyOriginal(new Uint8Array(bytes));
      return verified.isOk() ? verified.value : UNVERIFIED_SIGNATURE;
    }
    case "msg":
      return UNVERIFIED_SIGNATURE;
    default:
      format satisfies never;
      return panic("Unhandled email file format");
  }
};

const skipped = (
  reason: UploadedMailSkipReason,
): Result<UploadedMailOutcome, UploadedMailUnavailableError> => {
  if (reason !== "not_email") {
    logger.info("correspondence.upload.skipped", { reason });
  }
  return Result.ok({ status: "skipped", reason });
};

/**
 * Files an email file stored in a matter as correspondence linked to that
 * file. The uploader is the filer and must hold matter access when this runs.
 * Attachments stay inside the file; the record links the file instead of
 * storing them again. Replays converge on the file's one record.
 */
export const fileUploadedMail = async ({
  bytes,
  mimeType,
  scope,
  database,
  scopedDbForUploader = scopedDbForUploaderDefault,
  verifyOriginal = verifyOriginalSignature,
}: FileUploadedMailOptions): Promise<
  Result<UploadedMailOutcome, UploadedMailUnavailableError>
> => {
  if (!isUploadedMailMimeType(mimeType)) {
    return skipped("not_email");
  }
  const format = UPLOADED_MAIL_FORMATS[mimeType];
  const read = await Result.tryPromise({
    try: async () => await readUploader(database, scope),
    catch: unavailable,
  });
  if (read.isErr()) {
    return read;
  }
  const file = read.value;
  if (file === null) {
    return skipped("source_missing");
  }
  if (file.createdBy === null || file.uploaderEmail === null) {
    return skipped("no_uploader");
  }
  const userId = brandPersistedUserId(file.createdBy);
  const scopedDb = scopedDbForUploader({
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    userId,
  });
  const attached = await Result.tryPromise({
    try: async () => await isCorrespondenceAttachment(scopedDb, scope),
    catch: unavailable,
  });
  if (attached.isErr()) {
    return attached;
  }
  if (attached.value) {
    return skipped("correspondence_attachment");
  }
  const parsed = await parseEmailFile({ bytes, format });
  if (parsed.isErr()) {
    return skipped(PARSE_DROP_REASON[parsed.error.reason]);
  }
  const { from } = parsed.value;
  if (from === null) {
    return skipped("no_sender");
  }
  const created = await createCorrespondence({
    safeDb: safeDbFromScoped(scopedDb),
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    filer: { type: "user", userId },
    parsed: correspondenceFromMessage({
      message: { ...parsed.value, from },
      provenance: {
        source: "upload",
        sourceEntityId: scope.entityId,
        originalSignature: await uploadedSignature({
          bytes,
          format,
          verifyOriginal,
        }),
      },
      sender: file.uploaderEmail.toLowerCase(),
      receivedAt: file.createdAt.toISOString(),
    }),
    attachments: [],
    recordAuditEvent: createBackgroundAuditRecorder({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      userId,
      execution: {
        performer: { type: "user", id: userId },
        trigger: {
          type: "system",
          source: "uploaded_mail",
          sourceId: scope.entityId,
        },
      },
    }),
  });
  switch (created.type) {
    case "ok":
      return Result.ok({
        status: created.created ? "filed" : "duplicate",
        correspondenceId: created.id,
      });
    case "error":
      if (HandlerError.is(created.error) && created.error.status === 403) {
        return skipped("no_matter_access");
      }
      return Result.err(unavailable(created.error));
    case "invalid_content":
      return skipped("invalid_content");
    case "invalid_authentication":
      return panic("Uploaded correspondence failed provenance admission");
    default:
      created satisfies never;
      return panic("Unhandled correspondence result");
  }
};
