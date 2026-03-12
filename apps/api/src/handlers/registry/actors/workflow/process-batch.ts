import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ActionContextOf } from "rivetkit";

import type { WorkflowActorEvent } from "@stella/rivet/actors/workflow-actor-config";

import { isMockAI } from "@/api/consts";
import { createScopedDb, db } from "@/api/db";
import type { ScopedDb } from "@/api/db";
import { jsonField } from "@/api/db/json-utils";
import { fields, justifications } from "@/api/db/schema";
import type { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";
import { generateBatch } from "@/api/handlers/registry/actors/workflow/generate-batch";
import { generateBatchMock } from "@/api/handlers/registry/actors/workflow/generate-batch-mock";
import type { PropertyBatch } from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import { workflowActions } from "@/api/handlers/registry/actors/workflow/schema";
import type { WorkflowActionSchemas } from "@/api/handlers/registry/actors/workflow/schema";
import {
  prepareBatch,
  runWorkflowAction,
  setFieldsContent,
} from "@/api/handlers/registry/actors/workflow/utils";
import {
  broadcastEvent,
  parseBrandedWorkflowActorKey,
} from "@/api/handlers/registry/utils";
import { captureActorError } from "@/api/lib/errors/actions";
import type { FieldContent } from "@/api/types";

const { advanceQueue, processBatch } = workflowActions;

export const processBatchAction = async (
  c: ActionContextOf<typeof workflowActor>,
  { batchId, level, entityId }: WorkflowActionSchemas[typeof processBatch],
) =>
  await Result.tryPromise(async () => {
    const { organizationId, workspaceId } = parseBrandedWorkflowActorKey(c.key);
    const scopedDb = createScopedDb(db, [workspaceId], organizationId);

    const rawBatch = c.state.executionPlan
      .at(level)
      ?.find((b) => b.id === batchId);

    if (!rawBatch) {
      panic("Batch not found in execution plan");
    }

    const propertyIds = rawBatch.properties.map((p) => p.id);

    const entityRow = await scopedDb((tx) =>
      tx.query.entities.findFirst({
        columns: { currentVersionId: true },
        where: { id: entityId },
      }),
    );

    if (!entityRow?.currentVersionId) {
      panic("Entity has no current version");
    }

    const entityVersionId = entityRow.currentVersionId;

    // Get existing field content types for skip logic
    const batchFields = await scopedDb((tx) =>
      tx
        .select({
          propertyId: fields.propertyId,
          contentType: jsonField(fields.content, "v1")("type"),
        })
        .from(fields)
        .where(
          and(
            eq(fields.entityVersionId, entityVersionId),
            inArray(fields.propertyId, propertyIds),
          ),
        ),
    );

    const fieldContentMap = new Map<string, FieldContent["type"]>(
      batchFields.map((f) => [f.propertyId, f.contentType]),
    );

    const batch = prepareBatch(rawBatch, fieldContentMap);

    if (batch.properties.length === 0) {
      await runWorkflowAction(c, advanceQueue, {
        batchId,
        entityId,
      });
      return;
    }

    const result = await processWorkflowBatch(c, {
      entityId,
      entityVersionId,
      level,
      batch,
      scopedDb,
    });

    if (Result.isError(result)) {
      captureActorError({
        c,
        requestId: c.state.requestId,
        error: result.error,
        metadata: { entityId, batchId, level: String(level) },
      });

      await setFieldsContent(
        c,
        {
          workspaceId,
          entityId,
          entityVersionId,
          batch,
          contentType: "error",
        },
        scopedDb,
      );
    }

    await runWorkflowAction(c, advanceQueue, {
      batchId,
      entityId,
    });
  });

type ProcessWorkflowBatchProps = {
  entityId: string;
  entityVersionId: string;
  level: number;
  batch: PropertyBatch;
  scopedDb: ScopedDb;
};

const processWorkflowBatch = async (
  c: ActionContextOf<typeof workflowActor>,
  {
    entityId,
    entityVersionId,
    level,
    batch,
    scopedDb,
  }: ProcessWorkflowBatchProps,
) =>
  await Result.tryPromise(async () => {
    const { organizationId, workspaceId } = parseBrandedWorkflowActorKey(c.key);

    await setFieldsContent(
      c,
      {
        workspaceId,
        entityId,
        entityVersionId,
        batch,
        contentType: "pending",
      },
      scopedDb,
    );

    const generateFn = isMockAI() ? generateBatchMock : generateBatch;

    const result = await generateFn({
      abortSignal: c.abortSignal,
      batch,
      entityVersionId,
      organizationId,
      workspaceId,
      scopedDb,
    });

    const isBatchPending = c.state.executionPlan
      .at(level)
      ?.find((b) => b.id === batch.id);

    if (!isBatchPending || Result.isError(result)) {
      await setFieldsContent(
        c,
        {
          workspaceId,
          entityId,
          entityVersionId,
          batch,
          contentType: "error",
        },
        scopedDb,
      );
      return;
    }

    const processedFields = result.value;

    // All propertyIds being processed: delete their
    // existing fields first, cascade removes justifications.
    const allPropertyIds = [
      ...processedFields.aiResults.map((r) => r.propertyId),
      ...processedFields.unsupportedPropertyIds,
      ...processedFields.skippedPropertyIds,
    ];

    const updatedFields = await scopedDb(async (tx) => {
      // 1. Delete existing fields (cascade deletes
      //    their justifications).
      if (allPropertyIds.length > 0) {
        await tx
          .delete(fields)
          .where(
            and(
              eq(fields.entityVersionId, entityVersionId),
              inArray(fields.propertyId, allPropertyIds),
            ),
          );
      }

      // 2. Insert new field rows for AI results and
      //    unsupported properties (skipped = no row).
      const fieldValues = [
        ...processedFields.aiResults.map(
          ({ fieldId, propertyId, content }) => ({
            id: fieldId,
            workspaceId,
            propertyId,
            entityVersionId,
            content,
          }),
        ),
        ...processedFields.unsupportedPropertyIds.map((propertyId) => ({
          id: nanoid(),
          workspaceId,
          propertyId,
          entityVersionId,
          content: {
            type: "unsupported" as const,
            version: 1 as const,
          },
        })),
      ];

      if (fieldValues.length > 0) {
        await tx.insert(fields).values(fieldValues);
      }

      // 3. Insert justification rows referencing the
      //    new field rows.
      if (processedFields.aiJustifications.length > 0) {
        await tx.insert(justifications).values(
          processedFields.aiJustifications.map((j) => ({
            id: j.justificationId,
            workspaceId,
            fieldId: j.fieldId,
            htmlVersion: j.htmlVersion,
            htmlContent: j.htmlContent,
            fileFieldIds: j.fileFieldIds,
          })),
        );
      }

      return fieldValues;
    });

    broadcastEvent(c, {
      name: "field-content",
      data: [
        ...processedFields.skippedPropertyIds.map((propertyId) => ({
          // fieldId does not exist for skipped properties, because they are deleted from the database
          id: "",
          propertyId,
          entityId,
          content: null,
        })),
        ...updatedFields.map((f) => ({
          id: f.id,
          propertyId: f.propertyId,
          entityId,
          content: f.content,
        })),
      ],
    } satisfies WorkflowActorEvent);
  });
