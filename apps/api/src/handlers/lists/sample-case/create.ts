import { panic, Result } from "better-result";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  TransactionRollbackError,
} from "drizzle-orm";
import * as v from "valibot";

import {
  ENTITY_PRIORITY,
  LIST_ITEM_TYPE,
  TASK_STATUS,
} from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError, ScopedDb } from "@/api/db/safe-db";
import {
  abortableTx,
  abortTransaction,
  safeDbFromScoped,
} from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  legalListFactDetails,
  legalListItems,
  legalLists,
} from "@/api/db/schema";
import type { LegalListSampleCase } from "@/api/db/schema";
import { taskCreateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { defaultVarcharSchema } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import {
  documentWriteRefusal,
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
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
import { LIST_VERIFICATION_ITEM_OPERATION } from "@/api/lib/lists/item-operations";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { ensureFileProperty } from "@/api/lib/properties/ensure-file-property";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { SAMPLE_FACTS } from "./sample-case.data";
import sampleDocumentPath from "./whitfield-witness-statement.docx" with { type: "file" };

const SAMPLE_LIST_NAME = "Whitfield sample facts";
const SAMPLE_COMPETING_LOAD_REFUSED = failureSink({
  event: "lists.sample_case.competing_load_refused",
  expected: [],
});
const reportCompetingLoadRefusal = (
  error: unknown,
  workspaceId: SafeId<"workspace">,
) => {
  observeFailure(error, {
    sink: SAMPLE_COMPETING_LOAD_REFUSED,
    ctx: { workspaceId },
  });
};
const SAMPLE_LOAD_FAILED = failureSink({
  event: "lists.sample_case.load_failed",
  expected: [],
});
const SAMPLE_DOCUMENT_NAME = "Whitfield witness statement (sample).docx";

const config = {
  contract: "patch",
  description:
    "Load the bundled AVT sample case into the current matter: one fact list " +
    `with ${SAMPLE_FACTS.length} facts and their evidential details, plus a DOCX witness statement. ` +
    "The list, facts and document are committed together. Repeating this call " +
    "returns the same listId, documentEntityId and fileFieldId without changing " +
    "the sample, even after renaming it. Once its document or a sample fact " +
    "is deleted, the call loads a fresh complete sample with new IDs. " +
    "Requires access to list verification. " +
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
  body: v.object({ filePropertyName: defaultVarcharSchema }),
} satisfies WorkspaceHandlerConfig;

type SampleCaseResult = {
  listId: SafeId<"legalList">;
  documentEntityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
};

type SampleFileProperty = { name: string; recordAuditEvent: AuditRecorder };

/**
 * The workspace lock every sample read takes before the sample fence. The
 * buffer writer already holds it; preflight takes it first too, preserving the
 * creation owner's lock order.
 */
const lockSampleWorkspace = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  const status = await lockWorkspaceForEntityCreate(tx, workspaceId);
  if (status !== "active") {
    abortTransaction(
      documentWriteRefusal(
        status === undefined ? "workspace-not-found" : "workspace-not-active",
      ),
    );
  }
};

type SampleReceiptRow = {
  id: SafeId<"legalList">;
  sampleCase: LegalListSampleCase;
};

/**
 * Whether every row the receipt names is still live: the statement's file
 * field on a retained version of the document, and each sample fact still an
 * item of the sample list. Users delete these through the ordinary entity
 * paths, which cascade away the rows but cannot see the JSON receipt.
 */
const isSampleIntact = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  { id: listId, sampleCase }: SampleReceiptRow,
) => {
  const documentFields = await tx.$count(
    fields,
    and(
      eq(fields.workspaceId, workspaceId),
      eq(fields.id, sampleCase.fileFieldId),
      exists(
        tx
          .select({ id: entityVersions.id })
          .from(entityVersions)
          .where(
            and(
              eq(entityVersions.workspaceId, workspaceId),
              eq(entityVersions.id, fields.entityVersionId),
              eq(entityVersions.entityId, sampleCase.documentEntityId),
              isNull(entityVersions.deletedAt),
            ),
          ),
      ),
    ),
  );
  if (documentFields !== 1) {
    return false;
  }
  const liveFacts = await tx.$count(
    legalListItems,
    and(
      eq(legalListItems.workspaceId, workspaceId),
      eq(legalListItems.listId, listId),
      inArray(legalListItems.entityId, sampleCase.factEntityIds),
    ),
  );
  return liveFacts === sampleCase.factEntityIds.length;
};

type LockedSampleOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  /** Created here, under the lock, when the matter has no sample yet. */
  filePropertyName: string | undefined;
};

/**
 * The stored sample, read under the workspace lock and the sample fence. A
 * receipt whose document or facts were deleted is released, so the caller
 * loads a fresh, complete sample; what remains of the old one stays the
 * user's ordinary list and document.
 */
const readLockedSample = async ({
  tx,
  workspaceId,
  recordAuditEvent,
  filePropertyName,
}: LockedSampleOptions): Promise<SampleCaseResult | undefined> => {
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
  if (list !== undefined) {
    if (list.sampleCase === null) {
      return panic("A sample list must carry its receipt");
    }
    const receipt = { id: list.id, sampleCase: list.sampleCase };
    if (await isSampleIntact(tx, workspaceId, receipt)) {
      return {
        listId: list.id,
        documentEntityId: list.sampleCase.documentEntityId,
        fileFieldId: list.sampleCase.fileFieldId,
      };
    }
    await tx
      .update(legalLists)
      .set({ sampleCase: null, updatedAt: new Date() })
      .where(
        and(
          eq(legalLists.workspaceId, workspaceId),
          eq(legalLists.id, list.id),
        ),
      );
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
      resourceId: list.id,
      metadata: {
        operation: "sample_case_released",
        documentEntityId: list.sampleCase.documentEntityId,
      },
    });
  }
  // A matter without a file property gets one here, under the same lock,
  // so the statement can be stored and concurrent loads add only one.
  if (filePropertyName !== undefined) {
    await ensureFileProperty({
      tx,
      workspaceId,
      name: filePropertyName,
      recordAuditEvent,
    });
  }
  return undefined;
};

/** A refusal thrown to abort the read answers with its own status. */
const sampleReadError = (error: HandlerError | SafeDbError) =>
  DocumentWriteRefusedError.is(error.cause)
    ? documentWriteRefusalHandlerError(error.cause)
    : error;

const readSampleReceipt = async (
  scopedDb: ScopedDb,
  workspaceId: SafeId<"workspace">,
  fileProperty: SampleFileProperty,
) => {
  const result = await abortableTx(safeDbFromScoped(scopedDb), async (tx) => {
    await lockSampleWorkspace(tx, workspaceId);
    await withAggregateLock({
      tx,
      aggregate: "sampleCase",
      id: { workspaceId },
    });
    return await readLockedSample({
      tx,
      workspaceId,
      recordAuditEvent: fileProperty.recordAuditEvent,
      filePropertyName: fileProperty.name,
    });
  });
  return result.mapError(sampleReadError);
};

type InsertSampleOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  listId: SafeId<"legalList">;
  document: { entityId: SafeId<"entity">; fieldId: SafeId<"field"> };
  recordAuditEvent: AuditRecorder;
};

/** Writes the sample list, its facts and their details in the creator's transaction. */
const insertSample = async ({
  tx,
  workspaceId,
  userId,
  listId,
  document,
  recordAuditEvent,
}: InsertSampleOptions) => {
  const listCount = await tx.$count(
    legalLists,
    eq(legalLists.workspaceId, workspaceId),
  );
  if (listCount >= LIMITS.legalListsPerWorkspace) {
    abortTransaction(
      new HandlerError({
        status: 409,
        message: "This matter has reached the list limit.",
      }),
    );
  }
  const entityCount = await tx.$count(
    entities,
    eq(entities.workspaceId, workspaceId),
  );
  if (entityCount + SAMPLE_FACTS.length > LIMITS.entitiesCount) {
    abortTransaction(
      new HandlerError({
        status: 409,
        message: "This matter has no room for all sample facts.",
      }),
    );
  }
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
  await tx.insert(legalLists).values({
    id: listId,
    workspaceId,
    name: SAMPLE_LIST_NAME,
    createdBy: userId,
    sampleCase: {
      documentEntityId: document.entityId,
      fileFieldId: document.fieldId,
      factEntityIds: facts.map((fact) => fact.entityId),
    },
  });
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
        operation: "sample_case_fact_created",
        kind: "task",
        listItemType: LIST_ITEM_TYPE.FACT,
        listId,
      },
    })),
    ...facts.map((fact) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
      resourceId: fact.entityId,
      metadata: {
        operation: LIST_VERIFICATION_ITEM_OPERATION.factDetailsSet,
        listId,
        factDetails: fact.details,
      },
    })),
  ]);
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
}: LoadSampleCaseOptions) => {
  // Preflight takes the sample fence in this body so the route's declared
  // aggregate is visibly held; the retry read below repeats the same order.
  const preflight = await abortableTx(
    safeDbFromScoped(scopedDb),
    async (tx) => {
      await lockSampleWorkspace(tx, workspaceId);
      await withAggregateLock({
        tx,
        aggregate: "sampleCase",
        id: { workspaceId },
      });
      return await readLockedSample({
        tx,
        workspaceId,
        recordAuditEvent,
        filePropertyName,
      });
    },
  );
  return await Result.gen(async function* () {
    const existing = yield* preflight.mapError(sampleReadError);
    if (existing !== undefined) {
      return Result.ok(existing);
    }

    const concurrent: { receipt?: SampleCaseResult } = {};
    const listId = createSafeId<"legalList">();
    const attempted = await Result.tryPromise(
      async () =>
        await createDocument({
          authority: CALLER_AUTHORIZED,
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
            await lockSampleWorkspace(tx, workspaceId);
            await withAggregateLock({
              tx,
              aggregate: "sampleCase",
              id: { workspaceId },
            });
            const winner = await readLockedSample({
              tx,
              workspaceId,
              recordAuditEvent,
              filePropertyName: undefined,
            });
            if (winner !== undefined) {
              concurrent.receipt = winner;
              // The canonical writer reclaims the losing file and rolls back its
              // document, stamp, audit and intent finalization before this returns.
              tx.rollback();
            }
            await insertSample({
              tx,
              workspaceId,
              userId,
              listId,
              document,
              recordAuditEvent,
            });
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
          reportCompetingLoadRefusal(attempted.error, workspaceId);
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
};

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

const createSampleCase = createSafeHandler(
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
      observeFailure(result.error, {
        sink: SAMPLE_LOAD_FAILED,
        ctx: { workspaceId },
      });
    }
    const sample = yield* Result.await(Promise.resolve(result));
    return Result.ok(sample);
  },
);

declareAggregateMutation(createSampleCase, {
  type: "aggregate",
  aggregates: ["sampleCase"],
});

export default createSampleCase;
