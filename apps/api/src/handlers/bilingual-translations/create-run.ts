/**
 * Start a bilingual translation run from a reviewed preparation. The rows are
 * re-read from the pinned document version (the client only sends handles and
 * dispositions, never text), persisted with the confirmed glossary, and the
 * run is handed to the queue.
 */

import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { readBilingualDocx } from "@stll/folio-core/server";

import {
  bilingualTranslationRows,
  bilingualTranslationRuns,
} from "@/api/db/schema";
import { createBilingualRunBodySchema } from "@/api/handlers/bilingual-translations/schemas";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  BILINGUAL_ROW_DISPOSITION,
  BILINGUAL_RUN_ACTIVE_STATUSES,
} from "@/api/lib/bilingual/contract";
import type { BilingualRowDisposition } from "@/api/lib/bilingual/contract";
import { flattenBilingualRows } from "@/api/lib/bilingual/rows";
import { enqueueBilingualRun } from "@/api/lib/bilingual/run-queue";
import { createSafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-docx-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Start an asynchronous translation of a bilingual document using the reviewed row dispositions and glossary. Returns a run ID to poll.",
  permissions: { entity: ["create"] },
  access: "write",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  body: createBilingualRunBodySchema,
  requiresUsage: { actionType: "doc_review", modelRole: "chat" },
} satisfies HandlerConfig;

const createBilingualRun = createSafeHandler(
  config,
  async function* ({
    body,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const organizationId = session.activeOrganizationId;

    const loaded = yield* Result.await(
      loadEntityVersionDocxBuffer({
        safeDb,
        organizationId,
        workspaceId,
        entityId: body.entityId,
        fileFieldId: body.fieldId,
      }),
    );
    if (loaded.entityVersionId !== body.entityVersionId) {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "The document changed since it was prepared. Prepare it again.",
        }),
      );
    }

    const manifest = await Result.tryPromise({
      try: async () => await readBilingualDocx(loaded.buffer),
      catch: (cause) => cause,
    });
    if (Result.isError(manifest)) {
      captureError(manifest.error, { source: "bilingual-create-run" });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "The document could not be read",
        }),
      );
    }
    const { units } = flattenBilingualRows(manifest.value);
    const dispositionByRow = new Map<string, BilingualRowDisposition>();
    for (const row of body.rows) {
      dispositionByRow.set(row.rowId, row.disposition);
    }
    if (dispositionByRow.size !== body.rows.length) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Duplicate row in the request",
        }),
      );
    }
    const known = new Set(units.map((unit) => unit.rowId));
    for (const rowId of dispositionByRow.keys()) {
      if (!known.has(rowId)) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Unknown row in the request",
          }),
        );
      }
    }
    const assigned: {
      unit: (typeof units)[number];
      disposition: BilingualRowDisposition;
    }[] = [];
    for (const unit of units) {
      const disposition = dispositionByRow.get(unit.rowId);
      if (disposition !== undefined) {
        assigned.push({ unit, disposition });
      }
    }
    const missingCount = units.length - assigned.length;
    if (missingCount > 0) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: `${missingCount} rows have no disposition. Prepare the document again.`,
        }),
      );
    }

    const total = assigned.filter(
      ({ disposition }) => disposition !== BILINGUAL_ROW_DISPOSITION.KEEP,
    ).length;
    if (total === 0) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "No row is marked for translation.",
        }),
      );
    }

    const runId = createSafeId<"bilingualTranslationRun">();
    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        const active = await tx
          .select({ id: bilingualTranslationRuns.id })
          .from(bilingualTranslationRuns)
          .where(
            and(
              eq(bilingualTranslationRuns.workspaceId, workspaceId),
              eq(bilingualTranslationRuns.entityId, body.entityId),
              eq(bilingualTranslationRuns.fileFieldId, body.fieldId),
              inArray(bilingualTranslationRuns.status, [
                ...BILINGUAL_RUN_ACTIVE_STATUSES,
              ]),
            ),
          )
          .limit(1);
        if (active.length > 0) {
          return false;
        }
        await tx.insert(bilingualTranslationRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          entityId: body.entityId,
          fileFieldId: body.fieldId,
          entityVersionId: loaded.entityVersionId,
          sourceLang: body.sourceLang,
          targetLang: body.targetLang,
          glossary: body.glossary,
          status: "queued",
          total,
          requestedBy: user.id,
        });
        await tx.insert(bilingualTranslationRows).values(
          assigned.map(({ unit, disposition }) => ({
            id: createSafeId<"bilingualTranslationRow">(),
            organizationId,
            workspaceId,
            runId,
            rowId: unit.rowId,
            ordinal: unit.ordinal,
            kind: unit.kind,
            inTable: unit.inTable,
            tableLayout: unit.tableLayout,
            disposition,
            dispositionOrigin: "user" as const,
            sourceParaId: unit.sourceParaId,
            sourceText: unit.sourceText,
          })),
        );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.BILINGUAL_TRANSLATION_RUN,
          resourceId: runId,
          metadata: {
            entityId: body.entityId,
            rowCount: units.length,
            translatedRowCount: total,
            glossaryCount: body.glossary.length,
            sourceLang: body.sourceLang,
            targetLang: body.targetLang,
          },
        });
        return true;
      }),
    );
    if (!inserted) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A translation of this document is already in progress.",
        }),
      );
    }

    const enqueued = await Result.tryPromise({
      try: async () =>
        await enqueueBilingualRun({
          runId,
          workspaceId,
          organizationId,
          userId: user.id,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(enqueued)) {
      yield* Result.await(
        safeDb(async (tx) => {
          // audit: skip — status bookkeeping on the run row audited at insert.
          await tx
            .update(bilingualTranslationRuns)
            .set({
              status: "failed",
              errorCode: "enqueue_failed",
              finishedAt: new Date(),
            })
            .where(eq(bilingualTranslationRuns.id, runId));
        }),
      );
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to start the translation.",
          cause: enqueued.error,
        }),
      );
    }

    return Result.ok({ runId });
  },
);

export default createBilingualRun;
