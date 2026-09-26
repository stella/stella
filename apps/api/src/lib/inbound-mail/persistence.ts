import { Result, TaggedError, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { correspondence, correspondenceAttachments } from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/correspondence/create";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import {
  scanUpload,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { InboundFiler } from "@/api/lib/inbound-mail/acceptance";
import type { InboundDeliveryStore } from "@/api/lib/inbound-mail/ingest";
import { createInboundMailStore } from "@/api/lib/inbound-mail/store";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

class InboundAttachmentAlreadyLinked extends TaggedError(
  "InboundAttachmentAlreadyLinked",
)<{
  message: string;
}> {}

export class InboundPersistenceError extends TaggedError(
  "InboundPersistenceError",
)<{
  message: string;
}> {}

type InboundMatterScope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user"> | null;
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
    const scannedFiles = [];
    if (options.delivery.status === "candidate") {
      for (const attachment of options.delivery.attachments) {
        const scanned = await scanAttachment({
          bytes: attachment.bytes,
          fileName: attachment.fileName,
          declaredMimeType: attachment.mimeType,
        });
        if (scanned.isErr()) {
          if (!FileScanRejectedError.is(scanned.error)) {
            throw scanned.error;
          }
          return await createInboundMailStore({
            database,
            fileCandidate: async () =>
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
    const completions: {
      id: SafeId<"correspondence">;
      scope: InboundMatterScope;
      filer: InboundFiler;
    }[] = [];
    const persistRecord = createInboundMailStore({
      database,
      fileCandidate: async (candidate) => {
        const created = await createCorrespondence({
          safeDb: async (work) =>
            await Result.tryPromise(() => work(candidate.tx)),
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
            completions.push({
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
            });
            return {
              status: created.created ? "filed" : "duplicate",
              correspondenceId: created.id,
            };
          case "error":
            throw created.error;
          case "invalid_content":
          case "invalid_authentication":
            throw new InboundPersistenceError({
              message: "Inbound correspondence failed validation",
            });
          default:
            created satisfies never;
            return panic("Unhandled correspondence result");
        }
      },
    });
    const outcome = await persistRecord(options);
    for (const { id, scope, filer } of completions) {
      const scopedDb = scopedDbForMatter(scope);
      const recordAuditEvent = auditForFiler({ filer, ...scope });
      const linked = await scopedDb((tx) =>
        tx
          .select({ ordinal: correspondenceAttachments.ordinal })
          .from(correspondenceAttachments)
          .where(
            and(
              eq(correspondenceAttachments.correspondenceId, id),
              eq(correspondenceAttachments.workspaceId, scope.workspaceId),
              eq(
                correspondenceAttachments.organizationId,
                scope.organizationId,
              ),
            ),
          )
          .limit(scannedFiles.length + 1),
      );
      const completed = new Set(linked.map(({ ordinal }) => ordinal));
      for (const [ordinal, file] of scannedFiles.entries()) {
        if (completed.has(ordinal)) {
          continue;
        }
        const written = await Result.tryPromise({
          try: () =>
            createDocument({
              scopedDb,
              ...scope,
              recordAuditEvent,
              buffer: file.bytes,
              fileName: sanitizeFilename(file.fileName),
              mimeType: file.mimeType,
              scanWarnings: file.scanWarnings ?? undefined,
              afterCreate: async (tx, document) => {
                // The entity writer holds the matter lock. An ordinal can win once;
                // a losing retry rolls back its entity, audit and intent together.
                const records = await tx
                  .select({ id: correspondence.id })
                  .from(correspondence)
                  .where(
                    and(
                      eq(correspondence.id, id),
                      eq(correspondence.workspaceId, scope.workspaceId),
                      eq(correspondence.organizationId, scope.organizationId),
                    ),
                  )
                  .limit(1)
                  .for("share");
                if (records.length === 0) {
                  throw new InboundPersistenceError({
                    message: "Inbound correspondence is unavailable",
                  });
                }
                const inserted = await tx
                  .insert(correspondenceAttachments)
                  .values({
                    correspondenceId: id,
                    organizationId: scope.organizationId,
                    workspaceId: scope.workspaceId,
                    entityId: document.entityId,
                    ordinal,
                    filename: document.fileName,
                    mediaType: file.mimeType,
                    byteSize: file.bytes.byteLength,
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
                  throw new InboundAttachmentAlreadyLinked({
                    message: "Inbound attachment already linked",
                  });
                }
              },
            }),
          catch: (cause) => cause,
        });
        if (written.isErr()) {
          if (InboundAttachmentAlreadyLinked.is(written.error)) {
            continue;
          }
          throw written.error;
        }
        if (written.value.isErr()) {
          throw written.value.error;
        }
      }
    }
    return outcome;
  };
