import { panic, Result } from "better-result";
import { and, eq, isNotNull, TransactionRollbackError } from "drizzle-orm";
import { t } from "elysia";

import {
  ENTITY_PRIORITY,
  LIST_ITEM_TYPE,
  TASK_STATUS,
} from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  entities,
  legalListFactDetails,
  legalListItems,
  legalLists,
} from "@/api/db/schema";
import { taskCreateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import {
  documentWriteRefusal,
  DocumentWriteRefusedError,
  documentWriteRefusalHandlerError,
} from "@/api/lib/entities/authorize-document-write";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferResult } from "@/api/lib/entities/create-from-buffer";
import { createSiblingNamePlan } from "@/api/lib/entities/sibling-name-insert";
import { lockWorkspaceForEntityCreate } from "@/api/lib/entity-cap-lock";
import {
  AGENDA_ITEM_KIND,
  AGENDA_ITEM_SOURCE,
} from "@/api/lib/entity-constants";
import { insertEntityBatch } from "@/api/lib/entity-versions/insert-entity-batch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import { LIMITS } from "@/api/lib/limits";
import { ensureFileProperty } from "@/api/lib/properties/ensure-file-property";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { SAMPLE_FACTS } from "./sample-case.data";
import sampleDocumentPath from "./whitfield-witness-statement.docx" with { type: "file" };

const SAMPLE_LIST_NAME = "Whitfield sample facts";
const SAMPLE_DOCUMENT_NAME = "Whitfield witness statement (sample).docx";

const config = {
  contract: "patch",
  description:
    "Load the bundled AVT sample case into the current matter: one fact list " +
    `with ${SAMPLE_FACTS.length} facts and their evidential details, plus a DOCX witness statement. ` +
    "The list, facts and document are committed together. Repeating this call " +
    "returns the same listId, documentEntityId and fileFieldId without changing " +
    "the sample, even after renaming it. Requires access to list verification. " +
    "Use lists.verifications.create with listId, entityId=documentEntityId " +
    "and fileFieldId to check the statement.",
  permissions: { view: ["create"], entity: ["create"] },
  featureAccess: { type: "required", featureId: LIST_VERIFICATION_FEATURE_ID },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  realtime: taskCreateRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  body: t.Object({
    /** Name for the matter's file property if it has none yet (localized). */
    filePropertyName: tDefaultVarchar,
  }),
} satisfies WorkspaceHandlerConfig;

type SampleCaseResult = {
  listId: SafeId<"legalList">;
  documentEntityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
};

type SampleFileProperty = { name: string; recordAuditEvent: AuditRecorder };

const readLockedSample = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  fileProperty: SampleFileProperty | undefined,
) => {
  // The buffer writer already holds the workspace lock. Preflight takes it
  // first too, preserving the creation owner's lock order before this fence.
  const status = await lockWorkspaceForEntityCreate(tx, workspaceId);
  if (status !== "active") {
    throw documentWriteRefusal(
      status === undefined ? "workspace-not-found" : "workspace-not-active",
    );
  }
  await withAggregateLock({ tx, aggregate: "sampleCase", id: { workspaceId } });
  const list = (
    await tx
      .select({ id: legalLists.id, sampleCase: legalLists.sampleCase })
      .from(legalLists)
      .where(
        and(
          eq(legalLists.workspaceId, workspaceId),
          isNotNull(legalLists.sampleCase),
        ),
      )
      .limit(1)
  ).at(0);
  if (list === undefined) {
    // A matter without a file property gets one here, under the same lock,
    // so the statement can be stored and concurrent loads add only one.
    if (fileProperty !== undefined) {
      await ensureFileProperty({ tx, workspaceId, ...fileProperty });
    }
    return undefined;
  }
  if (list.sampleCase === null) {
    return panic("A sample list must carry its receipt");
  }
  return { listId: list.id, ...list.sampleCase };
};

const readSampleReceipt = async (
  scopedDb: ScopedDb,
  workspaceId: SafeId<"workspace">,
  fileProperty: SampleFileProperty,
) => {
  const result = await safeDbFromScoped(scopedDb)(
    async (tx) => await readLockedSample(tx, workspaceId, fileProperty),
  );
  return result.mapError((error) =>
    DocumentWriteRefusedError.is(error.cause)
      ? documentWriteRefusalHandlerError(error.cause)
      : error,
  );
};

type LoadSampleCaseOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  filePropertyName: string;
  createDocument?: typeof createEntityFromBuffer;
};

export const loadSampleCase = async ({
  scopedDb,
  workspaceId,
  organizationId,
  userId,
  recordAuditEvent,
  filePropertyName,
  createDocument = createEntityFromBuffer,
}: LoadSampleCaseOptions) =>
  await Result.gen(async function* () {
    const existing = yield* Result.await(
      readSampleReceipt(scopedDb, workspaceId, {
        name: filePropertyName,
        recordAuditEvent,
      }),
    );
    if (existing !== undefined) {
      return Result.ok(existing);
    }

    const concurrent: { receipt?: SampleCaseResult } = {};
    const listId = createSafeId<"legalList">();
    const attempted = await Result.tryPromise(
      async () =>
        await createDocument({
          scopedDb,
          workspaceId,
          organizationId,
          userId,
          recordAuditEvent,
          buffer: new Uint8Array(
            await Bun.file(sampleDocumentPath).arrayBuffer(),
          ),
          fileName: SAMPLE_DOCUMENT_NAME,
          mimeType: DOCX_MIME_TYPE,
          encryption: serverBuiltFileEncryption(),
          afterCreate: async (tx, document) => {
            // The property already exists by now; only the sample is read.
            const winner = await readLockedSample(tx, workspaceId, undefined);
            if (winner !== undefined) {
              concurrent.receipt = winner;
              // The canonical writer reclaims the losing file and rolls back its
              // document, stamp, audit and intent finalization before this returns.
              return tx.rollback();
            }
            const listCount = await tx.$count(
              legalLists,
              eq(legalLists.workspaceId, workspaceId),
            );
            if (listCount >= LIMITS.legalListsPerWorkspace) {
              throw new HandlerError({
                status: 409,
                message: "This matter has reached the list limit.",
              });
            }
            const entityCount = await tx.$count(
              entities,
              eq(entities.workspaceId, workspaceId),
            );
            if (entityCount + SAMPLE_FACTS.length > LIMITS.entitiesCount) {
              throw new HandlerError({
                status: 409,
                message: "This matter has no room for all sample facts.",
              });
            }
            await tx.insert(legalLists).values({
              id: listId,
              workspaceId,
              name: SAMPLE_LIST_NAME,
              createdBy: userId,
              sampleCase: {
                documentEntityId: document.entityId,
                fileFieldId: document.fieldId,
              },
            });
            const resolveName = await createSiblingNamePlan({
              tx,
              workspaceId,
            });
            const facts = SAMPLE_FACTS.map((fact, position) => ({
              ...fact,
              entityId: createSafeId<"entity">(),
              versionId: createSafeId<"entityVersion">(),
              name: resolveName({
                name: fact.statement,
                kind: "task",
                parentId: null,
              }).name,
              position: String(position).padStart(2, "0"),
            }));
            await insertEntityBatch({
              tx,
              stampOrigin: "issued",
              fieldRows: [],
              entityRows: facts.map((fact) => ({
                id: fact.entityId,
                workspaceId,
                kind: "task",
                listItemType: LIST_ITEM_TYPE.FACT,
                name: fact.name,
                createdBy: userId,
                agendaKind: AGENDA_ITEM_KIND.TASK,
                status: TASK_STATUS.OPEN,
                priority: ENTITY_PRIORITY.NONE,
                agendaSource: AGENDA_ITEM_SOURCE.MANUAL,
              })),
              versionRows: facts.map((fact) => ({
                id: fact.versionId,
                entityId: fact.entityId,
                workspaceId,
                versionNumber: 1,
              })),
              currentVersions: facts.map((fact) => ({
                entityId: fact.entityId,
                versionId: fact.versionId,
              })),
            });
            await tx.insert(legalListItems).values(
              facts.map((fact) => ({
                entityId: fact.entityId,
                workspaceId,
                listId,
                position: fact.position,
                addedBy: userId,
              })),
            );
            await tx.insert(legalListFactDetails).values(
              facts.map((fact) => ({
                itemEntityId: fact.entityId,
                workspaceId,
                listId,
                ...fact.details,
                updatedBy: userId,
              })),
            );
            await enqueueEntitySearchRepairs(
              tx,
              facts.map((fact) => fact.entityId),
            );
            await recordAuditEvent(tx, [
              {
                action: AUDIT_ACTION.CREATE,
                resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
                resourceId: listId,
                metadata: {
                  operation: "sample_case_loaded",
                  documentEntityId: document.entityId,
                },
              },
              ...facts.map((fact) => ({
                action: AUDIT_ACTION.CREATE,
                resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                resourceId: fact.entityId,
                metadata: {
                  kind: "task",
                  listItemType: LIST_ITEM_TYPE.FACT,
                  listId,
                },
              })),
              ...facts.map((fact) => ({
                action: AUDIT_ACTION.CREATE,
                resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
                resourceId: fact.entityId,
                metadata: { listId, factDetails: fact.details },
              })),
            ]);
          },
        }),
    );
    if (
      concurrent.receipt !== undefined &&
      attempted.isErr() &&
      attempted.error.cause instanceof TransactionRollbackError
    ) {
      return Result.ok(concurrent.receipt);
    }
    if (attempted.isErr() || attempted.value.isErr()) {
      // A competing commit can exhaust capacity before the buffer writer
      // reaches afterCreate. Its refusal must still converge on that sample.
      const winner = yield* Result.await(
        readSampleReceipt(scopedDb, workspaceId, {
          name: filePropertyName,
          recordAuditEvent,
        }),
      );
      if (winner !== undefined) {
        if (attempted.isErr()) {
          captureError(attempted.error, { workspaceId });
        }
        return Result.ok(winner);
      }
    }
    if (attempted.isErr()) {
      if (HandlerError.is(attempted.error.cause)) {
        return Result.err(attempted.error.cause);
      }
      return Result.err(attempted.error);
    }
    const document = yield* attempted.value.mapError(sampleDocumentError);
    return Result.ok({
      listId,
      documentEntityId: document.entityId,
      fileFieldId: document.fieldId,
    });
  });

type BufferError = Extract<
  CreateEntityFromBufferResult,
  { status: "error" }
>["error"];
const sampleDocumentError = (error: BufferError): HandlerError => {
  if (error instanceof OrganizationFileUsageError) {
    return organizationFileUsageHandlerError(error);
  }
  if (DocumentWriteRefusedError.is(error)) {
    return documentWriteRefusalHandlerError(error);
  }
  switch (error._tag) {
    case "DocumentTooLargeError":
      return new HandlerError({
        status: 413,
        message: "The sample document exceeds the file size limit.",
      });
    case "EntityLimitError":
      return new HandlerError({
        status: 409,
        message: "This matter has reached the document limit.",
      });
    case "MissingFilePropertyError":
      return new HandlerError({
        status: 422,
        message:
          "Add a file property to this matter before loading the sample case.",
      });
    case "InvalidParentError":
      return panic("The sample document has no parent");
    default:
      error satisfies never;
      return panic("Unhandled sample document creation error");
  }
};

export default createSafeHandler(
  config,
  async function* ({
    scopedDb,
    workspaceId,
    session,
    user,
    recordAuditEvent,
    body,
  }) {
    const result = await loadSampleCase({
      scopedDb,
      workspaceId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      recordAuditEvent,
      filePropertyName: body.filePropertyName,
    });
    if (result.isErr()) {
      captureError(result.error, { workspaceId });
    }
    return yield* Result.await(Promise.resolve(result));
  },
);
