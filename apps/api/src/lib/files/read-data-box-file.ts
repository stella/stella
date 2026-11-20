import { Result } from "better-result";
import type { InferOk } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { CORRESPONDENCE_MAX_ATTACHMENTS } from "@stll/api-contract/correspondence";
import type {
  DataBoxDeliveryEvent,
  DataBoxEnvelope,
} from "@stll/api-contract/data-box";

import type { Transaction } from "@/api/db/root";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceSources,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import { withDataBoxDirection } from "@/api/lib/email/correspondence/data-box/direction";
import { dataBoxDocumentText } from "@/api/lib/email/correspondence/data-box/document-text";
import { readOrganizationDataBoxIds } from "@/api/lib/email/correspondence/data-box/organization-boxes";
import { readDataBoxPreview } from "@/api/lib/email/correspondence/data-box/read-preview";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FileScanRejectedError } from "@/api/lib/file-scan/scan-upload";
import {
  type LegalFileReadOptions,
  legalSourceChanged,
  loadLegalFileSource,
} from "@/api/lib/files/legal-file-source";
import { extractFileTextResult } from "@/api/lib/search/extract-content";

/** One read of a data-box file: its envelope as stated, and its source text. */
type DataBoxFileRead =
  | {
      readonly kind: "receipt";
      readonly annotation: string;
      readonly envelope: DataBoxEnvelope;
      readonly events: readonly DataBoxDeliveryEvent[];
      readonly text: string;
    }
  | {
      readonly kind: "message";
      readonly annotation: string;
      readonly envelope: DataBoxEnvelope;
      readonly text: string;
      readonly files: readonly {
        fileName: string;
        entityId: SafeId<"entity"> | null;
      }[];
    };

type FiledAttachmentOptions = {
  tx: Transaction;
  sourceEntityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  message: Extract<
    InferOk<Awaited<ReturnType<typeof readDataBoxPreview>>>,
    { kind: "message" }
  >;
};

/** One source files one record of at most this many members, each normally with one file. */
const FILED_ATTACHMENT_ROW_CAP = 2 * CORRESPONDENCE_MAX_ATTACHMENTS;

const readFiledAttachments = async ({
  tx,
  sourceEntityId,
  workspaceId,
  message,
}: FiledAttachmentOptions) => {
  // An entity link opens its current file. Multiple candidates or an edited file
  // cannot identify the bytes this envelope contained.
  // Registration is per entity. The payload hash binds these ordinals to the selected version.
  const query = tx
    .select({
      ordinal: correspondenceAttachments.ordinal,
      entityId: correspondenceAttachments.entityId,
      hash: sql<string | null>`${fields.content}->>'sha256Hex'`,
      encrypted: sql<boolean>`(${fields.content}->>'encrypted')::boolean`,
    })
    .from(correspondenceSources)
    .innerJoin(
      correspondence,
      and(
        eq(correspondence.id, correspondenceSources.correspondenceId),
        eq(correspondence.workspaceId, workspaceId),
      ),
    )
    .innerJoin(
      correspondenceAttachments,
      and(
        eq(correspondenceAttachments.correspondenceId, correspondence.id),
        eq(correspondenceAttachments.workspaceId, workspaceId),
      ),
    )
    .innerJoin(
      entities,
      and(
        eq(entities.id, correspondenceAttachments.entityId),
        eq(entities.workspaceId, workspaceId),
      ),
    )
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, entities.currentVersionId),
        eq(entityVersions.entityId, entities.id),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      fields,
      and(
        eq(fields.workspaceId, workspaceId),
        eq(fields.entityVersionId, entityVersions.id),
        sql`${fields.content}->>'type' = 'file'`,
      ),
    )
    .where(
      and(
        eq(correspondenceSources.entityId, sourceEntityId),
        eq(correspondenceSources.workspaceId, workspaceId),
        eq(correspondence.channel, "data_box"),
        eq(correspondence.contentHash, message.contentHash),
      ),
    );
  const links = await readBounded(query, FILED_ATTACHMENT_ROW_CAP);
  // More rows than two files per member cannot name one file per ordinal.
  if (links.type === "overflow") {
    return new Map<number, SafeId<"entity">>();
  }
  const unique = new Map<number, SafeId<"entity">>();
  const seen = new Set<number>();
  for (const { ordinal, entityId, hash, encrypted } of links.rows) {
    if (seen.has(ordinal)) {
      unique.delete(ordinal);
    } else if (!encrypted && hash === message.files.at(ordinal)?.sha256Hex) {
      unique.set(ordinal, entityId);
    }
    seen.add(ordinal);
  }
  return unique;
};

export const readDataBoxFile = async (
  options: LegalFileReadOptions,
): Promise<Result<DataBoxFileRead, HandlerError>> => {
  const {
    scopedDb,
    workspaceId,
    organizationId,
    purpose = "preview",
  } = options;
  const loaded = await loadLegalFileSource(options, "dataBox");
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { source, mimeType, entityId, deliver } = loaded.value;
  const preview = await readDataBoxPreview(source);
  if (preview.isErr()) {
    return Result.err(preview.error);
  }
  const doc = preview.value;

  let text = dataBoxDocumentText(doc);
  let readEmbeddedFiles = false;
  if (purpose !== "preview" && doc.kind === "message" && doc.files.length > 0) {
    const needsEmbeddedText =
      purpose === "standalone" ||
      (
        await scopedDb(
          async (tx) =>
            await readFiledAttachments({
              tx,
              sourceEntityId: entityId,
              workspaceId,
              message: doc,
            }),
        )
      ).size !== doc.files.length;
    if (needsEmbeddedText) {
      // Older uploads may predate correspondence filing. Read their exact
      // embedded bytes; the final transaction still gates content delivery.
      const standalone = await extractFileTextResult(
        source.withMimeType(mimeType),
        {
          includeContainerAttachments: true,
        },
      );
      if (standalone.isErr()) {
        return Result.err(
          new HandlerError(
            standalone.error.workerErrorClass === FileScanRejectedError.name
              ? {
                  status: 422,
                  code: PREVIEW_UNAVAILABLE_ERROR_CODE,
                  message: "An embedded file failed its security scan",
                }
              : {
                  status: 503,
                  code: "upstream_unavailable",
                  message: "The attachment reader is unavailable",
                  cause: standalone.error,
                },
          ),
        );
      }
      if (standalone.value === null) {
        return Result.err(
          new HandlerError({
            status: 422,
            code: PREVIEW_UNAVAILABLE_ERROR_CODE,
            message: "This data-box file has no readable text",
          }),
        );
      }
      text = standalone.value;
      readEmbeddedFiles = true;
    }
  }
  return await deliver(
    async (tx): Promise<Result<DataBoxFileRead, HandlerError>> => {
      const boxIds = await readOrganizationDataBoxIds(tx, organizationId);
      const envelope = withDataBoxDirection(doc.envelope, boxIds);
      const byOrdinal =
        doc.kind === "message"
          ? await readFiledAttachments({
              tx,
              sourceEntityId: entityId,
              workspaceId,
              message: doc,
            })
          : new Map<number, SafeId<"entity">>();
      if (
        purpose === "agent" &&
        doc.kind === "message" &&
        !readEmbeddedFiles &&
        byOrdinal.size !== doc.files.length
      ) {
        return legalSourceChanged();
      }
      if (doc.kind === "receipt") {
        return Result.ok({
          kind: doc.kind,
          annotation: doc.annotation,
          envelope,
          events: doc.events,
          text,
        } as const);
      }
      return Result.ok({
        kind: doc.kind,
        annotation: doc.annotation,
        envelope,
        text,
        files: doc.files.map(({ fileName }, index) => ({
          fileName,
          entityId: byOrdinal.get(index) ?? null,
        })),
      } as const);
    },
  );
};
