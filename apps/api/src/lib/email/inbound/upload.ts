import { panic, Result, TaggedError } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import type {
  CorrespondenceOriginalSignature,
  ParsedCorrespondence,
} from "@stll/api-contract/correspondence";
import { DATA_BOX_MESSAGE_MIME_TYPE } from "@stll/api-contract/data-box";
import {
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
  type EMAIL_MIME_TYPES,
} from "@stll/api-contract/email-mime-types";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped, type ScopedDb } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAttachments,
  entities,
} from "@/api/db/schema";
import {
  createBackgroundAuditRecorder,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  parseDataBoxMessage,
  type DataBoxMessageParseError,
  type ParsedDataBoxMessage,
} from "@/api/lib/data-box/zfo";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { verifyOriginalSignature } from "@/api/lib/email/inbound/authentication";
import { PARSE_DROP_REASON } from "@/api/lib/email/inbound/ingest";
import {
  correspondenceFromMessage,
  parseEmailFile,
  type EmailFileFormat,
} from "@/api/lib/email/inbound/message";
import { finishCorrespondenceAttachments } from "@/api/lib/email/inbound/persistence";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import { observeScanFailures } from "@/api/lib/file-scan/scan-upload-handler";
import { logger } from "@/api/lib/observability/logger";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

const UPLOADED_MAIL_FORMATS = {
  [EML_MIME_TYPE]: "eml",
  [MSG_MIME_TYPE]: "msg",
  [DATA_BOX_MESSAGE_MIME_TYPE]: "zfo",
} as const satisfies Record<
  keyof typeof EMAIL_MIME_TYPES | typeof DATA_BOX_MESSAGE_MIME_TYPE,
  EmailFileFormat | "zfo"
>;

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
  | `data_box_${DataBoxMessageParseError["reason"]}`
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
  createDocument?: typeof createEntityFromBuffer;
  scanAttachment?: typeof scanUpload;
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

type CreatedCorrespondence = Awaited<ReturnType<typeof createCorrespondence>>;

const filingOutcome = (
  created: CreatedCorrespondence,
): Result<UploadedMailOutcome, UploadedMailUnavailableError> => {
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

/** The uploaded file and its uploader, once both are established. */
type UploadedFiling = {
  bytes: ArrayBuffer;
  scope: UploadedMailScope;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  receivedAt: string;
  recordAuditEvent: AuditRecorder;
};

type DataBoxCorrespondenceOptions = {
  message: ParsedDataBoxMessage;
  bytes: ArrayBuffer;
  sourceEntityId: SafeId<"entity">;
  uploadedAt: string;
};

/**
 * The one field mapping from a data-box message to a correspondence record.
 * The file does not say which box was the firm's, so the record is incoming;
 * its addresses are box IDs and its subject is the annotation.
 */
const dataBoxCorrespondence = ({
  message: { annotation, envelope },
  bytes,
  sourceEntityId,
  uploadedAt,
}: DataBoxCorrespondenceOptions): ParsedCorrespondence => ({
  source: "upload",
  sourceEntityId,
  originalSignature: UNVERIFIED_SIGNATURE,
  channel: "data_box",
  dataBox: envelope,
  direction: "in",
  messageId: envelope.messageId,
  contentHash: hashSha256Hex(new Uint8Array(bytes)),
  from: { address: envelope.sender.boxId, name: envelope.sender.name },
  to: [{ address: envelope.recipient.boxId, name: envelope.recipient.name }],
  cc: [],
  subject: annotation,
  sentAt: null,
  receivedAt: envelope.deliveredAt ?? uploadedAt,
  inReplyTo: null,
  references: [],
  bodyText: "",
  bodyHtml: null,
});

// The message's files are stored in the `.zfo` file's folder.
const readSourceFolder = async ({ scopedDb, scope }: UploadedFiling) =>
  await scopedDb(async (tx) => {
    const [file] = await tx
      .select({ parentId: entities.parentId })
      .from(entities)
      .where(
        and(
          eq(entities.id, scope.entityId),
          eq(entities.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1);
    return file?.parentId ?? null;
  });

// The record's own file stores the message's files; another file of the same
// message only adds its uploader as a filer.
const isRecordSource = async (
  { scopedDb, scope }: UploadedFiling,
  correspondenceId: SafeId<"correspondence">,
) =>
  await scopedDb(async (tx) => {
    const [record] = await tx
      .select({ sourceEntityId: correspondence.sourceEntityId })
      .from(correspondence)
      .where(
        and(
          eq(correspondence.id, correspondenceId),
          eq(correspondence.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1);
    return record?.sourceEntityId === scope.entityId;
  });

type FileUploadedDataBoxMessageOptions = {
  filing: UploadedFiling;
  createDocument: typeof createEntityFromBuffer;
  scanAttachment: typeof scanUpload;
};

/**
 * Files a `.zfo` data-box message. Its files are scanned before anything is
 * written and stored as documents beside the `.zfo` file, linked as the
 * record's attachments. The message ID keys the record in the matter, so a
 * replay or another file of the same message converges on it.
 */
const fileUploadedDataBoxMessage = async ({
  filing,
  createDocument,
  scanAttachment,
}: FileUploadedDataBoxMessageOptions): Promise<
  Result<UploadedMailOutcome, UploadedMailUnavailableError>
> => {
  const { bytes, scope, userId, scopedDb, recordAuditEvent } = filing;
  const parsed = parseDataBoxMessage(new Uint8Array(bytes));
  if (parsed.isErr()) {
    return skipped(`data_box_${parsed.error.reason}`);
  }
  const scannedFiles = [];
  for (const file of parsed.value.files) {
    // db-await-in-loop: scans only, no database work; bounded by DATA_BOX_MESSAGE_LIMITS.maxFiles
    const scanned = await scanAttachment({
      bytes: file.bytes,
      fileName: sanitizeFilename(file.fileName),
      declaredMimeType: file.mimeType,
    });
    if (scanned.isErr()) {
      observeScanFailures(scanned.error);
      return FileScanRejectedError.is(scanned.error)
        ? skipped("attachment_rejected")
        : Result.err(unavailable(scanned.error));
    }
    scannedFiles.push(scanned.value);
  }
  const created = await createCorrespondence({
    safeDb: safeDbFromScoped(scopedDb),
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    filer: { type: "user", userId },
    parsed: dataBoxCorrespondence({
      message: parsed.value,
      bytes,
      sourceEntityId: scope.entityId,
      uploadedAt: filing.receivedAt,
    }),
    attachments: [],
    recordAuditEvent,
  });
  const outcome = filingOutcome(created);
  if (outcome.isErr() || outcome.value.status === "skipped") {
    return outcome;
  }
  const { correspondenceId } = outcome.value;
  const ownsRecord = await Result.tryPromise({
    try: async () => await isRecordSource(filing, correspondenceId),
    catch: unavailable,
  });
  if (ownsRecord.isErr()) {
    return ownsRecord;
  }
  if (!ownsRecord.value) {
    return outcome;
  }
  const parentId = await Result.tryPromise({
    try: async () => await readSourceFolder(filing),
    catch: unavailable,
  });
  if (parentId.isErr()) {
    return parentId;
  }
  const finished = await finishCorrespondenceAttachments({
    correspondenceId,
    scope: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      userId,
    },
    scannedFiles,
    scopedDb,
    recordAuditEvent,
    createDocument,
    parentId: parentId.value,
  });
  return finished.isErr() ? Result.err(unavailable(finished.error)) : outcome;
};

/**
 * Files an email file or a data-box `.zfo` file stored in a matter as
 * correspondence linked to that file. The uploader is the filer and must hold
 * matter access when this runs. An email file keeps its attachments inside
 * the file; the record links the file instead of storing them again, and
 * replays converge on the file's one record.
 */
export const fileUploadedMail = async ({
  bytes,
  mimeType,
  scope,
  database,
  scopedDbForUploader = scopedDbForUploaderDefault,
  verifyOriginal = verifyOriginalSignature,
  createDocument = createEntityFromBuffer,
  scanAttachment = scanUpload,
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
  const recordAuditEvent = createBackgroundAuditRecorder({
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
  });
  if (format === "zfo") {
    return await fileUploadedDataBoxMessage({
      filing: {
        bytes,
        scope,
        userId,
        scopedDb,
        receivedAt: file.createdAt.toISOString(),
        recordAuditEvent,
      },
      createDocument,
      scanAttachment,
    });
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
    recordAuditEvent,
  });
  return filingOutcome(created);
};
