import { panic, Result, TaggedError } from "better-result";
import type { InferOk } from "better-result";
import { and, eq, exists, isNull } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceSources,
  entities,
} from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import type { InboundFiler } from "@/api/lib/email/inbound/acceptance";
import {
  type InboundDeliveryStore,
  InboundPersistenceError,
} from "@/api/lib/email/inbound/ingest";
import { createInboundMailStore } from "@/api/lib/email/inbound/store";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import { observeScanFailures } from "@/api/lib/file-scan/scan-upload-handler";
import {
  detectFileEncryption,
  retainedFileEncryption,
} from "@/api/lib/files/detect-file-encryption";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

class InboundAttachmentAlreadyLinked extends TaggedError(
  "InboundAttachmentAlreadyLinked",
)<{
  message: string;
}> {}

export class StaleCorrespondenceAttachmentError extends TaggedError(
  "StaleCorrespondenceAttachmentError",
)<{ message: string }> {}

type AttachmentGeneration =
  | { type: "delivery"; contentHash: string }
  | {
      type: "upload";
      contentHash: string;
      sourceEntityId: SafeId<"entity">;
      sourceVersionId: SafeId<"entityVersion"> | null;
    };

type InboundMatterScope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user"> | null;
};

type LinkInboundAttachmentOptions = {
  tx: Transaction;
  correspondenceId: SafeId<"correspondence">;
  scope: InboundMatterScope;
  entityId: SafeId<"entity">;
  filename: string;
  mediaType: string;
  byteSize: number;
  ordinal: number;
  generation: AttachmentGeneration;
};

type CurrentAttachmentGenerationOptions = Pick<
  LinkInboundAttachmentOptions,
  "tx" | "correspondenceId" | "scope" | "generation"
>;

const isCurrentAttachmentGeneration = async ({
  tx,
  correspondenceId,
  scope,
  generation,
}: CurrentAttachmentGenerationOptions) => {
  const sourceCondition =
    generation.type === "delivery"
      ? eq(correspondence.source, "delivery")
      : exists(
          tx
            .select({ id: entities.id })
            .from(entities)
            .innerJoin(
              correspondenceSources,
              and(
                eq(correspondenceSources.entityId, entities.id),
                eq(correspondenceSources.workspaceId, entities.workspaceId),
              ),
            )
            .where(
              and(
                eq(entities.id, generation.sourceEntityId),
                eq(entities.workspaceId, scope.workspaceId),
                eq(correspondenceSources.organizationId, scope.organizationId),
                eq(correspondenceSources.correspondenceId, correspondenceId),
                generation.sourceVersionId === null
                  ? isNull(entities.currentVersionId)
                  : eq(entities.currentVersionId, generation.sourceVersionId),
              ),
            ),
        );
  const records = await tx
    .select({ id: correspondence.id })
    .from(correspondence)
    .where(
      and(
        eq(correspondence.id, correspondenceId),
        eq(correspondence.workspaceId, scope.workspaceId),
        eq(correspondence.organizationId, scope.organizationId),
        eq(correspondence.contentHash, generation.contentHash),
        sourceCondition,
      ),
    )
    .limit(1);
  return records.length > 0;
};

const linkInboundAttachment = async ({
  tx,
  correspondenceId,
  scope,
  entityId,
  filename,
  mediaType,
  byteSize,
  ordinal,
  generation,
}: LinkInboundAttachmentOptions) => {
  // The entity writer holds the matter lock. An ordinal can win once;
  // the caller rolls back a losing entity, audit and intent together.
  const records = await tx
    .select({ id: correspondence.id })
    .from(correspondence)
    .where(
      and(
        eq(correspondence.id, correspondenceId),
        eq(correspondence.workspaceId, scope.workspaceId),
        eq(correspondence.organizationId, scope.organizationId),
      ),
    )
    .limit(1)
    .for("share");
  if (records.length === 0) {
    return Result.err(
      new InboundPersistenceError({
        message: "Inbound correspondence is unavailable",
      }),
    );
  }
  // The existing record lock serializes a refresh with this claim; the
  // document writer also holds the matter lock through its attachment write.
  if (
    !(await isCurrentAttachmentGeneration({
      tx,
      correspondenceId,
      scope,
      generation,
    }))
  ) {
    return Result.err(
      new StaleCorrespondenceAttachmentError({
        message: "Correspondence attachment generation changed",
      }),
    );
  }
  const inserted = await tx
    .insert(correspondenceAttachments)
    .values({
      correspondenceId,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityId,
      ordinal,
      filename,
      mediaType,
      byteSize,
      scanVerdict: "clean",
    })
    .onConflictDoNothing({
      target: [
        correspondenceAttachments.correspondenceId,
        correspondenceAttachments.ordinal,
      ],
    })
    .returning({ id: correspondenceAttachments.id });
  if (inserted.length === 0) {
    return Result.err(
      new InboundAttachmentAlreadyLinked({
        message: "Inbound attachment already linked",
      }),
    );
  }
  return Result.ok(undefined);
};

type CreateInboundMailPersistenceOptions = {
  database: {
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  };
  scopedDbForMatter: (scope: InboundMatterScope) => ScopedDb;
  createDocument?: typeof createEntityFromBuffer;
  scanAttachment?: typeof scanUpload;
};

const auditForFiler = ({
  filer,
  organizationId,
  workspaceId,
}: {
  filer: InboundFiler;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}) =>
  createBackgroundAuditRecorder({
    organizationId,
    workspaceId,
    userId:
      filer.type === "user" ? filer.userId : `mailbox:${filer.allowedSenderId}`,
    execution: {
      performer:
        filer.type === "user"
          ? { type: "user", id: filer.userId }
          : {
              type: "service",
              id: `mailbox:${filer.allowedSenderId}`,
              name: null,
            },
      trigger: { type: "webhook", source: "inbound_mail" },
    },
  });

/** PDF probes in flight per delivery; each may run to the extraction timeout. */
const INBOUND_ENCRYPTION_PROBE_CONCURRENCY = 4;

type InboundCompletion = {
  id: SafeId<"correspondence">;
  scope: InboundMatterScope;
  filer: InboundFiler;
  contentHash: string;
};

type FinishCorrespondenceAttachmentsOptions = {
  correspondenceId: SafeId<"correspondence">;
  scope: InboundMatterScope;
  scannedFiles: readonly InferOk<Awaited<ReturnType<typeof scanUpload>>>[];
  scopedDb: ScopedDb;
  recordAuditEvent: AuditRecorder;
  createDocument: typeof createEntityFromBuffer;
  /** The folder the documents are stored in; the matter root when null. */
  parentId: SafeId<"entity"> | null;
  generation: AttachmentGeneration;
};

/**
 * Stores each scanned attachment not yet linked to the filed correspondence,
 * so a retry resumes at the missing ordinals.
 */
export const finishCorrespondenceAttachments = async ({
  correspondenceId: id,
  scope,
  scannedFiles,
  scopedDb,
  recordAuditEvent,
  createDocument,
  parentId,
  generation,
}: FinishCorrespondenceAttachmentsOptions): Promise<
  Result<
    undefined,
    InboundPersistenceError | StaleCorrespondenceAttachmentError
  >
> => {
  const current = await scopedDb(
    async (tx) =>
      await isCurrentAttachmentGeneration({
        tx,
        correspondenceId: id,
        scope,
        generation,
      }),
  );
  if (!current) {
    return Result.err(
      new StaleCorrespondenceAttachmentError({
        message: "Correspondence attachment generation changed",
      }),
    );
  }
  const linked = await scopedDb((tx) =>
    tx
      .select({ ordinal: correspondenceAttachments.ordinal })
      .from(correspondenceAttachments)
      .where(
        and(
          eq(correspondenceAttachments.correspondenceId, id),
          eq(correspondenceAttachments.workspaceId, scope.workspaceId),
          eq(correspondenceAttachments.organizationId, scope.organizationId),
        ),
      )
      .limit(scannedFiles.length + 1),
  );
  const completed = new Set(linked.map(({ ordinal }) => ordinal));
  // Filing keeps every attachment, so an unreadable or unsure PDF is still
  // stored (and reported); the detection only decides what its row records.
  // The probes run a few at a time before the sequential writes, so stalled
  // PDFs overlap instead of holding the delivery one timeout after another.
  const encryptions = new Map(
    await mapWithConcurrency({
      items: [...scannedFiles.entries()].filter(
        ([ordinal]) => !completed.has(ordinal),
      ),
      limit: INBOUND_ENCRYPTION_PROBE_CONCURRENCY,
      operation: async ([ordinal, file]) =>
        [
          ordinal,
          retainedFileEncryption(
            await detectFileEncryption({
              mimeType: file.mimeType,
              scanned: file,
            }),
            handlerErrorContext("inboundMail.detectEncryption", {
              mimeType: file.mimeType,
              stage: "inbound-attachment",
            }),
          ),
        ] as const,
    }),
  );
  for (const [ordinal, file] of scannedFiles.entries()) {
    const encryption = encryptions.get(ordinal);
    if (completed.has(ordinal) || encryption === undefined) {
      continue;
    }
    const aborted: {
      error:
        | InboundPersistenceError
        | InboundAttachmentAlreadyLinked
        | StaleCorrespondenceAttachmentError
        | null;
    } = { error: null };
    const written = await Result.tryPromise({
      try: async () =>
        // db-await-in-loop: one stored document and ordinal claim per attachment, each in its own transaction so a retry resumes at the missing ordinals; bounded by CORRESPONDENCE_MAX_ATTACHMENTS
        await createDocument({
          scopedDb,
          ...scope,
          recordAuditEvent,
          buffer: file.bytes,
          fileName: sanitizeFilename(file.fileName),
          mimeType: file.mimeType,
          encryption,
          parentId,
          scanWarnings: file.scanWarnings ?? undefined,
          afterCreate: async (tx, document) => {
            const attachmentLink = await linkInboundAttachment({
              tx,
              correspondenceId: id,
              scope,
              entityId: document.entityId,
              filename: document.fileName,
              mediaType: file.mimeType,
              byteSize: file.bytes.byteLength,
              ordinal,
              generation,
            });
            if (attachmentLink.isErr()) {
              aborted.error = attachmentLink.error;
              return tx.rollback();
            }
            return undefined;
          },
        }),
      catch: (cause) =>
        aborted.error ??
        new InboundPersistenceError({
          message: "Inbound attachment write could not complete",
          cause,
        }),
    });
    if (written.isErr()) {
      if (InboundAttachmentAlreadyLinked.is(written.error)) {
        continue;
      }
      return Result.err(written.error);
    }
    if (written.value.isErr()) {
      return Result.err(
        new InboundPersistenceError({
          message: "Inbound attachment could not be created",
          cause: written.value.error,
        }),
      );
    }
  }
  return Result.ok(undefined);
};

// The transport retains the source until this resolves successfully. A retry
// reuses the correspondence/filer rows and finishes only missing attachments.
export const createInboundMailPersistence =
  ({
    database,
    scopedDbForMatter,
    createDocument = createEntityFromBuffer,
    scanAttachment = scanUpload,
  }: CreateInboundMailPersistenceOptions): InboundDeliveryStore =>
  async (options) => {
    const persisted = await Result.tryPromise({
      try: async () => {
        const scannedFiles = [];
        if (options.delivery.status === "candidate") {
          for (const attachment of options.delivery.attachments) {
            const scanned = await scanAttachment({
              bytes: attachment.bytes,
              fileName: attachment.fileName,
              declaredMimeType: attachment.mimeType,
            });
            if (scanned.isErr()) {
              observeScanFailures(scanned.error);
              if (!FileScanRejectedError.is(scanned.error)) {
                return Result.err(
                  new InboundPersistenceError({
                    message: "Inbound attachment scan could not complete",
                    cause: scanned.error,
                  }),
                );
              }
              return await createInboundMailStore({
                database,
                fileCandidate: () =>
                  panic("Rejected attachment reached filing"),
              })({
                ...options,
                delivery: {
                  status: "drop",
                  sender: options.delivery.sender,
                  reason: "attachment_rejected",
                },
              });
            }
            scannedFiles.push(scanned.value);
          }
        }
        // A delivery's recipient token resolves to one matter, so the store
        // files at most one candidate; its attachments are finished below.
        const filed: { completion: InboundCompletion | null } = {
          completion: null,
        };
        const persistRecord = createInboundMailStore({
          database,
          fileCandidate: async (candidate) => {
            const created = await createCorrespondence({
              safeDb: async (work) =>
                await Result.tryPromise(async () => await work(candidate.tx)),
              organizationId: candidate.organizationId,
              workspaceId: candidate.workspaceId,
              filer: candidate.filer,
              parsed: candidate.delivery.message,
              attachments: [],
              recordAuditEvent: auditForFiler({
                filer: candidate.filer,
                organizationId: candidate.organizationId,
                workspaceId: candidate.workspaceId,
              }),
            });
            switch (created.type) {
              case "ok":
                filed.completion = {
                  id: created.id,
                  filer: candidate.filer,
                  scope: {
                    organizationId: candidate.organizationId,
                    workspaceId: candidate.workspaceId,
                    userId:
                      candidate.filer.type === "user"
                        ? candidate.filer.userId
                        : null,
                  },
                  contentHash: created.contentHash,
                };
                return Result.ok({
                  status: created.created
                    ? ("filed" as const)
                    : ("duplicate" as const),
                  correspondenceId: created.id,
                });
              case "error":
                return Result.err(
                  new InboundPersistenceError({
                    message: "Inbound correspondence could not be filed",
                    cause: created.error,
                  }),
                );
              case "invalid_content":
              case "invalid_authentication":
              case "source_changed":
                return Result.err(
                  new InboundPersistenceError({
                    message: "Inbound correspondence failed validation",
                  }),
                );
              default:
                created satisfies never;
                return panic("Unhandled correspondence result");
            }
          },
        });
        const outcome = await persistRecord(options);
        if (outcome.isErr()) {
          return outcome;
        }
        const completion = filed.completion;
        if (!completion) {
          return outcome;
        }
        const finished = await finishCorrespondenceAttachments({
          correspondenceId: completion.id,
          scope: completion.scope,
          scannedFiles,
          scopedDb: scopedDbForMatter(completion.scope),
          recordAuditEvent: auditForFiler({
            filer: completion.filer,
            ...completion.scope,
          }),
          createDocument,
          parentId: null,
          generation: { type: "delivery", contentHash: completion.contentHash },
        });
        if (finished.isErr()) {
          return Result.err(
            StaleCorrespondenceAttachmentError.is(finished.error)
              ? new InboundPersistenceError({
                  message: "Inbound attachment generation changed",
                  cause: finished.error,
                })
              : finished.error,
          );
        }
        return outcome;
      },
      catch: (cause) =>
        new InboundPersistenceError({
          message: "Inbound persistence could not complete",
          cause,
        }),
    });
    return persisted.andThen((outcome) => outcome);
  };
