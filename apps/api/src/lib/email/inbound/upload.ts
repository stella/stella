import { panic, Result, TaggedError } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import type {
  CorrespondenceOriginalSignature,
  ParsedCorrespondence,
} from "@stll/api-contract/correspondence";
import { DATA_BOX_MESSAGE_MIME_TYPE } from "@stll/api-contract/data-box";
import {
  type EMAIL_MIME_TYPES,
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
} from "@stll/api-contract/email-mime-types";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped, type ScopedDb } from "@/api/db/safe-db";
import {
  correspondenceAttachments,
  entities,
  fields,
  workspaces,
} from "@/api/db/schema";
import {
  type AuditRecorder,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  createCorrespondence,
  retireCorrespondenceSource,
} from "@/api/lib/email/correspondence/create";
import {
  type DataBoxMessageParseError,
  parseDataBoxMessage,
  type ParsedDataBoxMessage,
} from "@/api/lib/email/correspondence/data-box/zfo";
import { verifyOriginalSignature } from "@/api/lib/email/inbound/authentication";
import { PARSE_DROP_REASON } from "@/api/lib/email/inbound/ingest";
import {
  correspondenceFromMessage,
  type EmailFileFormat,
  parseEmailFile,
} from "@/api/lib/email/inbound/message";
import {
  finishCorrespondenceAttachments,
  StaleCorrespondenceAttachmentError,
} from "@/api/lib/email/inbound/persistence";
import { normalizeEmail } from "@/api/lib/email/normalized-email";
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
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";

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
  | "source_changed"
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
 * Filing or completion failed. Retry the same source generation; any already
 * committed record and attachment ordinals are resumed idempotently.
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
  sourceFileId?: string;
  scope: UploadedMailScope;
  /** The filing job's connection; it reads only the file's uploader. */
  database: {
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  };
  scopedDbForUploader?: (scope: UploaderScope) => ScopedDb;
  scopedDbForSource?: (scope: UploadedMailScope) => ScopedDb;
  verifyOriginal?: typeof verifyOriginalSignature;
  createDocument?: typeof createEntityFromBuffer;
  scanAttachment?: typeof scanUpload;
  createRecord?: typeof createCorrespondence;
};

const scopedDbForUploaderDefault = ({
  organizationId,
  workspaceId,
  userId,
}: UploaderScope) =>
  createRootScopedDb({ organizationId, userId, workspaceIds: [workspaceId] });

const scopedDbForSourceDefault = ({
  organizationId,
  workspaceId,
}: UploadedMailScope) =>
  createRootScopedDb({
    organizationId,
    userId: null,
    workspaceIds: [workspaceId],
  });

type ReadUploadedSourceOptions = {
  database: FileUploadedMailOptions["database"];
  scope: UploadedMailScope;
  sourceFileId?: string;
};

// Membership scopes uploader attribution; the immutable file id fences stale jobs.
const readUploader = async ({
  database,
  scope: { entityId, workspaceId, organizationId },
  sourceFileId,
}: ReadUploadedSourceOptions) =>
  await withAggregateTransaction(database, async (tx) => {
    const [file] = await tx
      .select({
        createdBy: entities.createdBy,
        createdAt: entities.createdAt,
        currentVersionId: entities.currentVersionId,
        sourceMatches: sql<boolean>`EXISTS (
          SELECT 1 FROM ${fields}
          WHERE ${fields.workspaceId} = ${workspaceId}
            AND ${fields.entityVersionId} = ${entities.currentVersionId}
            AND ${fields.content}->>'type' = 'file'
            AND ${fields.content}->>'id' = ${sourceFileId ?? null}
        )`,
        uploaderEmail: user.email,
      })
      .from(entities)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, entities.workspaceId),
          eq(workspaces.organizationId, organizationId),
        ),
      )
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

type RetireUploadedMailSourceOptions = ReadUploadedSourceOptions & {
  scopedDbForSource?: (scope: UploadedMailScope) => ScopedDb;
};

/** Retire extraction for this generation while retaining filed user history. */
export const retireUploadedMailSource = async ({
  database,
  scope,
  sourceFileId,
  scopedDbForSource = scopedDbForSourceDefault,
}: RetireUploadedMailSourceOptions): Promise<
  Result<UploadedMailOutcome, UploadedMailUnavailableError>
> => {
  const read = await Result.tryPromise({
    try: async () =>
      await readUploader({
        database,
        scope,
        ...(sourceFileId === undefined ? {} : { sourceFileId }),
      }),
    catch: unavailable,
  });
  if (read.isErr()) {
    return read;
  }
  const file = read.value;
  if (file === null) {
    return skipped("source_missing");
  }
  if (file.currentVersionId !== null && !file.sourceMatches) {
    return skipped("source_changed");
  }
  return await retireUploadedMailVersion({
    scope,
    expectedSourceVersionId: file.currentVersionId,
    scopedDbForSource,
  });
};

type RetireUploadedMailVersionOptions = {
  scope: UploadedMailScope;
  expectedSourceVersionId: SafeId<"entityVersion"> | null;
  scopedDbForSource: NonNullable<FileUploadedMailOptions["scopedDbForSource"]>;
};

const retireUploadedMailVersion = async ({
  scope,
  expectedSourceVersionId,
  scopedDbForSource,
}: RetireUploadedMailVersionOptions): Promise<
  Result<UploadedMailOutcome, UploadedMailUnavailableError>
> => {
  const actor = TENANT_SYSTEM_ACTOR.uploadedMail;
  const retired = await retireCorrespondenceSource({
    safeDb: safeDbFromScoped(scopedDbForSource(scope)),
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    sourceEntityId: scope.entityId,
    expectedSourceVersionId,
    recordAuditEvent: createBackgroundAuditRecorder({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      userId: actor,
      execution: {
        performer: {
          type: "service",
          id: actor,
          name: "Uploaded correspondence",
        },
        trigger: { type: "system", source: actor, sourceId: scope.entityId },
      },
    }),
  });
  switch (retired.type) {
    case "ok":
      return skipped("not_email");
    case "source_changed":
      return skipped("source_changed");
    case "error":
      return Result.err(unavailable(retired.error));
    default:
      retired satisfies never;
      return panic("Unhandled correspondence retirement result");
  }
};

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
    case "source_changed":
      return skipped("source_changed");
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
  expectedSourceVersionId: SafeId<"entityVersion"> | null;
};

type DataBoxCorrespondenceOptions = {
  message: ParsedDataBoxMessage;
  sourceEntityId: SafeId<"entity">;
  uploadedAt: string;
};

/**
 * The one field mapping from a data-box message to a correspondence record.
 * Its addresses are box IDs and its subject is the annotation. Direction is
 * derived from current organization settings when the record is read.
 */
const dataBoxCorrespondence = ({
  message: { annotation, envelope, files },
  sourceEntityId,
  uploadedAt,
}: DataBoxCorrespondenceOptions): ParsedCorrespondence => ({
  source: "upload",
  sourceEntityId,
  originalSignature: UNVERIFIED_SIGNATURE,
  channel: "data_box",
  dataBox: envelope,
  direction: null,
  messageId: envelope.messageId,
  // Bind every ordinal, including files not yet written, to the parsed payload.
  // CMS serialization and unverified message IDs cannot establish equivalence.
  contentHash: hashSha256Hex(
    JSON.stringify([
      annotation,
      envelope,
      files.map(({ fileName, mimeType, bytes }) => [
        fileName,
        mimeType,
        hashSha256Hex(bytes),
      ]),
    ]),
  ),
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

type FileUploadedDataBoxMessageOptions = {
  filing: UploadedFiling;
  createDocument: typeof createEntityFromBuffer;
  scanAttachment: typeof scanUpload;
  createRecord: typeof createCorrespondence;
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
  createRecord,
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
  const content = dataBoxCorrespondence({
    message: parsed.value,
    sourceEntityId: scope.entityId,
    uploadedAt: filing.receivedAt,
  });
  const created = await createRecord({
    safeDb: safeDbFromScoped(scopedDb),
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    filer: { type: "user", userId },
    parsed: content,
    attachments: [],
    expectedSourceVersionId: filing.expectedSourceVersionId,
    recordAuditEvent,
  });
  const outcome = filingOutcome(created);
  if (created.type !== "ok") {
    return outcome;
  }
  if (created.contentHash !== content.contentHash) {
    return skipped("invalid_content");
  }
  const correspondenceId = created.id;
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
    generation: {
      type: "upload",
      sourceEntityId: scope.entityId,
      sourceVersionId: filing.expectedSourceVersionId,
      contentHash: created.contentHash,
    },
  });
  if (
    finished.isErr() &&
    StaleCorrespondenceAttachmentError.is(finished.error)
  ) {
    return skipped("source_changed");
  }
  return finished.isErr() ? Result.err(unavailable(finished.error)) : outcome;
};

/**
 * Files an email file or a data-box `.zfo` file stored in a matter as
 * correspondence linked to that file. The uploader is the filer and must hold
 * matter access when this runs. An email file keeps its attachments inside
 * the file; the record links the file instead of storing them again, and
 * replays converge on the file's one record.
 */
const attemptUploadedMail = async ({
  bytes,
  mimeType,
  scope,
  scopedDbForUploader = scopedDbForUploaderDefault,
  file,
  verifyOriginal = verifyOriginalSignature,
  createDocument = createEntityFromBuffer,
  scanAttachment = scanUpload,
  createRecord = createCorrespondence,
}: FileUploadedMailOptions & {
  file: Awaited<ReturnType<typeof readUploader>>;
}): Promise<Result<UploadedMailOutcome, UploadedMailUnavailableError>> => {
  if (!isUploadedMailMimeType(mimeType)) {
    return skipped("not_email");
  }
  const format = UPLOADED_MAIL_FORMATS[mimeType];
  if (file === null) {
    return skipped("source_missing");
  }
  if (file.currentVersionId !== null && !file.sourceMatches) {
    return skipped("source_changed");
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
        expectedSourceVersionId: file.currentVersionId,
      },
      createDocument,
      scanAttachment,
      createRecord,
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
  const created = await createRecord({
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
      sender: normalizeEmail(file.uploaderEmail),
      receivedAt: file.createdAt.toISOString(),
    }),
    attachments: [],
    expectedSourceVersionId: file.currentVersionId,
    recordAuditEvent,
  });
  return filingOutcome(created);
};

/** Every terminal non-filing result reconciles the attempted source generation. */
export const fileUploadedMail = async (
  options: FileUploadedMailOptions,
): Promise<Result<UploadedMailOutcome, UploadedMailUnavailableError>> => {
  const read = await Result.tryPromise({
    try: async () => await readUploader(options),
    catch: unavailable,
  });
  if (read.isErr()) {
    return read;
  }
  const file = read.value;
  const outcome = await attemptUploadedMail({ ...options, file });
  if (outcome.isErr() || outcome.value.status !== "skipped") {
    return outcome;
  }
  // Missing or stale jobs must never detach the current generation. All other
  // refusals, including access denial, retire under the captured version token.
  if (
    file === null ||
    (file.currentVersionId !== null && !file.sourceMatches)
  ) {
    return outcome;
  }
  const retired = await retireUploadedMailVersion({
    scope: options.scope,
    expectedSourceVersionId: file.currentVersionId,
    scopedDbForSource: options.scopedDbForSource ?? scopedDbForSourceDefault,
  });
  if (
    retired.isErr() ||
    (retired.value.status === "skipped" &&
      retired.value.reason === "source_changed")
  ) {
    return retired;
  }
  return outcome;
};
