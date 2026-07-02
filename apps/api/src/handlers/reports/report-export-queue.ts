/**
 * Background queue for view→report exports.
 *
 * Reuses the same BullMQ infrastructure that backs the file-derivative and
 * workflow queues (no new queue system). A DD view is routinely 100+ contracts
 * and each contract draws a metered AI draft, which no synchronous request
 * survives (ALB/browser timeouts) and which is a known p95 hazard on the API —
 * so the export is a one-shot background job from day one.
 *
 * One-shot semantics: `attempts: 1`. A retry would re-run the metered AI drafts
 * and could double-create a workspace document; instead ANY failure is captured
 * onto the `report_exports` row (`status: "failed"` + `error`) so the job is
 * never silently stuck and the status endpoint can surface it.
 */

import { Result } from "better-result";
import { Queue, Worker } from "bullmq";
import { and, eq } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db";
import { reportExports } from "@/api/db/schema";
import type { ReportTemplateRef } from "@/api/db/schema";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import { buildReportData } from "@/api/handlers/reports/build-report-data";
import { getBuiltinReportTemplate } from "@/api/handlers/reports/builtin-templates";
import {
  fillStoredTemplateDocx,
  fillTemplateDocx,
} from "@/api/handlers/templates/template-fill-service";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { hasInstanceProvider } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { recoverStuckReportExports } from "@/api/lib/report-export-recovery";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import {
  brandPersistedReportExportId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { parseViewLayout } from "@/api/lib/views-schema";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "report-exports";
const JOB_NAME = "export-report";
const WORKER_CONCURRENCY = 2;
// One attempt: the fill runs metered AI and (in workspace mode) creates a
// document; a BullMQ retry would double both. Failures are persisted on the row.
const JOB_ATTEMPTS = 1;
const ERROR_MESSAGE_MAX_CHARS = 1000;
const DOCX_TO_PDF_ERROR = "Failed to convert the report to PDF.";

/** Delivery format chosen at export time. Carried on the job (not the export
 *  row): the worker needs it to convert + name the artifact, and the status
 *  endpoint derives the download filename from the stored key's extension, so
 *  no schema column is required. */
export type ReportExportFormat = "docx" | "pdf";

type ReportExportJobData = {
  exportId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
  format: ReportExportFormat;
  /** Include AI-drafted narrative sections. Carried on the job (not the export
   *  row): the worker needs it to gate the AI generators + template sections.
   *  Optional for back-compat with jobs enqueued before this field existed;
   *  absent means "on". */
  aiNarrative?: boolean;
};

export type EnqueueReportExportArgs = {
  exportId: SafeId<"reportExport">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  format: ReportExportFormat;
  aiNarrative: boolean;
};

let queue: Queue<ReportExportJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<ReportExportJobData> => {
  queue ??= new Queue<ReportExportJobData>(QUEUE_NAME, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: JOB_ATTEMPTS,
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return queue;
};

export const enqueueReportExport = async ({
  exportId,
  workspaceId,
  organizationId,
  userId,
  format,
  aiNarrative,
}: EnqueueReportExportArgs): Promise<void> => {
  await getQueue().add(
    JOB_NAME,
    { exportId, workspaceId, organizationId, userId, format, aiNarrative },
    { jobId: createBullMqJobId(workspaceId, exportId) },
  );
};

/** Human-readable failure string persisted on the export row. */
export const toExportErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message.slice(0, ERROR_MESSAGE_MAX_CHARS);
  }
  if (typeof cause === "string") {
    return cause.slice(0, ERROR_MESSAGE_MAX_CHARS);
  }
  return "Report export failed";
};

export const initReportExportWorker = () => {
  // Heal exports stranded by a previous process's hard death before serving new
  // ones. Fire-and-forget: a sweep failure must not block worker startup, and
  // the next boot re-attempts it.
  recoverStuckReportExports()
    .then((count) => {
      if (count > 0) {
        logger.warn("report_export.recovered_stuck", { count: String(count) });
      }
      return count;
    })
    .catch((error: unknown) => {
      captureError(error, { operation: "report_export.recover_stuck" });
    });

  const workerConnection = createBullMqConnection();

  const worker = new Worker<ReportExportJobData>(
    QUEUE_NAME,
    async (job) => {
      await processReportExportJob(job.data);
    },
    { connection: workerConnection, concurrency: WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, error) => {
    // The job body already persists failures onto the row; this is the last
    // resort if the process itself threw before that could run.
    if (job) {
      markExportFailed(job.data, toExportErrorMessage(error)).catch(
        (markError: unknown) => {
          captureError(markError, {
            exportId: job.data.exportId,
            workspaceId: job.data.workspaceId,
          });
        },
      );
    }
    captureError(error, {
      exportId: job?.data.exportId ?? "",
      workspaceId: job?.data.workspaceId ?? "",
    });
    logger.error("report_export.failed", {
      exportId: job?.data.exportId ?? "",
      "error.type": errorTag(error),
      workspaceId: job?.data.workspaceId ?? "",
    });
  });

  worker.on("error", (error) => {
    logger.error("report_export.worker_error", connectionErrorFields(error));
  });

  logger.info("report_export.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return worker;
};

type ExportActor = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  exportId: SafeId<"reportExport">;
};

const brandActor = (data: ReportExportJobData): ExportActor => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId: data.organizationId,
    workspaceId: data.workspaceId,
  });
  const userId = brandPersistedUserId(data.userId);
  return {
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    userId,
    exportId: brandPersistedReportExportId(data.exportId),
    scopedDb: createRootScopedDb({
      organizationId: branded.organizationId,
      userId,
      workspaceIds: [branded.workspaceId],
    }),
    safeDb: createRootSafeDb({
      organizationId: branded.organizationId,
      userId,
      workspaceIds: [branded.workspaceId],
    }),
  };
};

const processReportExportJob = async (
  data: ReportExportJobData,
): Promise<void> => {
  const actor = brandActor(data);
  const { exportId } = actor;

  const row = await actor.scopedDb((tx) =>
    tx.query.reportExports.findFirst({
      where: {
        id: { eq: exportId },
        workspaceId: { eq: actor.workspaceId },
      },
      columns: { status: true, mode: true, templateRef: true, layout: true },
    }),
  );

  // Only a freshly queued row runs; a re-delivered job (or one already terminal)
  // is a no-op so the export never double-runs its AI/document creation.
  if (!row || row.status !== "queued") {
    return;
  }

  await setExportStatus(actor, "running");

  const outcome = await Result.tryPromise({
    try: async () =>
      await runExport({
        actor,
        row,
        format: data.format,
        aiNarrative: data.aiNarrative ?? true,
      }),
    catch: (cause) => cause,
  });

  if (Result.isError(outcome)) {
    await markExportFailed(data, toExportErrorMessage(outcome.error));
  }
};

type ExportRow = {
  mode: "workspace" | "download";
  templateRef: ReportTemplateRef;
  layout: unknown;
};

/** Delivery artifact: the bytes to store plus the mime + extension that name
 *  it. `pdf` runs the filled DOCX through Gotenberg; conversion failure is a
 *  typed error string persisted on the row. */
export type ReportDelivery =
  | { buffer: Uint8Array; mimeType: string; ext: ReportExportFormat }
  | { error: string };

/** Injectable seam for the DOCX→PDF conversion so the format branching is
 *  unit-testable without reaching Gotenberg. */
type ConvertReportToPdf = (
  docx: Buffer,
) => Promise<Result<ArrayBuffer, unknown>>;

const convertReportDocxToPdf: ConvertReportToPdf = async (docx) => {
  const bytes = new Uint8Array(docx);
  const result = await convertToPdf(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "report.docx",
    DOCX_MIME_TYPE,
  );
  if (Result.isError(result)) {
    return result;
  }
  return Result.ok(result.value.buffer);
};

/** Resolve the delivery artifact for the chosen format. DOCX passes the filled
 *  buffer through unchanged; PDF converts via `convertToPdfBuffer`. */
export const buildReportDelivery = async ({
  docxBuffer,
  format,
  convertToPdfBuffer = convertReportDocxToPdf,
}: {
  docxBuffer: Buffer;
  format: ReportExportFormat;
  convertToPdfBuffer?: ConvertReportToPdf;
}): Promise<ReportDelivery> => {
  if (format === "docx") {
    return {
      buffer: new Uint8Array(docxBuffer),
      mimeType: DOCX_MIME_TYPE,
      ext: "docx",
    };
  }
  const pdf = await convertToPdfBuffer(docxBuffer);
  if (Result.isError(pdf)) {
    return { error: DOCX_TO_PDF_ERROR };
  }
  return {
    buffer: new Uint8Array(pdf.value),
    mimeType: PDF_MIME_TYPE,
    ext: "pdf",
  };
};

const runExport = async ({
  actor,
  row,
  format,
  aiNarrative,
}: {
  actor: ExportActor;
  row: ExportRow;
  format: ReportExportFormat;
  aiNarrative: boolean;
}): Promise<void> => {
  const layout = parseViewLayout(row.layout);
  if (layout.type !== "table") {
    await markExportFailedRow(
      actor,
      "Only table views can be exported to a report.",
    );
    return;
  }

  const workspace = await actor.safeDb((tx) =>
    tx.query.workspaces.findFirst({
      where: { id: { eq: actor.workspaceId } },
      columns: { name: true },
    }),
  );
  const workspaceName = Result.isError(workspace)
    ? "Workspace"
    : (workspace.value?.name ?? "Workspace");

  const dataResult = await buildReportData({
    safeDb: actor.safeDb,
    workspaceId: actor.workspaceId,
    organizationId: actor.organizationId,
    currentUserId: actor.userId,
    layout,
    workspaceName,
    aiNarrative,
  });
  if (Result.isError(dataResult)) {
    await markExportFailedRow(actor, dataResult.error.message);
    return;
  }

  // Deterministic export: skip loading the org AI config entirely; fillReport
  // builds no generators and runs no usage preflight when aiNarrative is off.
  const orgAIConfig = aiNarrative
    ? await loadOrgAIConfig(actor.organizationId)
    : null;
  const filled = await fillReport({
    actor,
    templateRef: row.templateRef,
    reportData: dataResult.value,
    orgAIConfig,
    aiNarrative,
  });

  if ("usageRejection" in filled) {
    await markExportFailedRow(
      actor,
      "AI usage is unavailable for this organization.",
    );
    return;
  }
  if ("error" in filled) {
    await markExportFailedRow(actor, filled.error);
    return;
  }

  const delivery = await buildReportDelivery({
    docxBuffer: filled.buffer,
    format,
  });
  if ("error" in delivery) {
    await markExportFailedRow(actor, delivery.error);
    return;
  }

  const fileName = sanitizeFilename(
    `${workspaceName} - ${filled.templateName}.${delivery.ext}`,
  );

  if (row.mode === "workspace") {
    const created = await createEntityFromBuffer({
      scopedDb: actor.scopedDb,
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      recordAuditEvent: createBackgroundAuditRecorder({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
      }),
      buffer: delivery.buffer,
      fileName,
      mimeType: delivery.mimeType,
    });
    if (Result.isError(created)) {
      await markExportFailedRow(actor, created.error.message);
      return;
    }
    await completeExport(actor, {
      resultEntityId: created.value.entityId,
    });
    return;
  }

  // Download mode: write under the root exports/ prefix (S3 lifecycle prefix
  // filters anchor at the key start, so the scratch prefix must lead the key;
  // org/workspace segments keep the key tenant-scoped); the status endpoint
  // presigns it. The stored key's extension is what the status endpoint uses
  // to name the download, so no format column is needed on the export row.
  const key = `exports/${actor.organizationId}/${actor.workspaceId}/${actor.exportId}.${delivery.ext}`;
  await getS3().write(key, delivery.buffer);
  await completeExport(actor, { resultS3Key: key });
};

type FillReportResult =
  | { templateName: string; fileName: string; buffer: Buffer }
  | { error: string }
  | { usageRejection: unknown };

const fillReport = async ({
  actor,
  templateRef,
  reportData,
  orgAIConfig,
  aiNarrative,
}: {
  actor: ExportActor;
  templateRef: ReportTemplateRef;
  reportData: Record<string, unknown>;
  orgAIConfig: OrgAIConfig | null;
  aiNarrative: boolean;
}): Promise<FillReportResult> => {
  // Deterministic export: no generators (resolveAiFields is a no-op without a
  // generator) and no usage preflight. The template's {{#if aiNarrative}}
  // sections are removed at fill time, so the unfilled AI-field placeholders
  // never survive into the output.
  const generators = aiNarrative
    ? buildReportAiGenerators({ actor, orgAIConfig })
    : {};

  return await fillReportDocx({
    actor,
    templateRef,
    values: reportData,
    generators,
  });
};

/** The AI generator bundle passed into the fill pipeline; every field is
 *  optional so a deterministic export can pass `{}`. */
type ReportAiGenerators = {
  generateAiValue?: ReturnType<typeof buildAiFieldGenerator>;
  decideAiCondition?: ReturnType<typeof buildAiConditionDecider>;
  adaptAiValue?: ReturnType<typeof buildAiOccurrenceAdapter>;
  assertUsageAvailable?: () => Promise<unknown>;
};

/** Build the metered AI generators + usage preflight for a narrative export. */
const buildReportAiGenerators = ({
  actor,
  orgAIConfig,
}: {
  actor: ExportActor;
  orgAIConfig: OrgAIConfig | null;
}): ReportAiGenerators => {
  const aiAnalytics = createAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "chat",
      organizationId: actor.organizationId,
      safeDb: actor.safeDb,
      serviceTier: "standard",
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
    feature: "templates.fill",
    modelRole: "fast",
    orgAIConfig,
    properties: { organization_id: actor.organizationId },
    traceId: Bun.randomUUIDv7(),
  });

  const assertUsageAvailable =
    orgAIConfig || hasInstanceProvider()
      ? async () =>
          await assertUsageAvailableForHandler({
            metering: { actionType: "chat", modelRole: "fast" },
            organizationId: actor.organizationId,
            orgAIConfig,
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            safeDb: actor.safeDb,
          })
      : undefined;

  const skillContext = {
    organizationId: actor.organizationId,
    safeDb: actor.safeDb,
    userId: actor.userId,
  };
  return {
    generateAiValue: buildAiFieldGenerator({
      orgAIConfig,
      organizationId: actor.organizationId,
      skillContext,
      aiAnalytics,
    }),
    decideAiCondition: buildAiConditionDecider({
      orgAIConfig,
      organizationId: actor.organizationId,
      skillContext,
      aiAnalytics,
    }),
    adaptAiValue: buildAiOccurrenceAdapter({
      orgAIConfig,
      organizationId: actor.organizationId,
      skillContext,
      aiAnalytics,
    }),
    assertUsageAvailable,
  };
};

/** Dispatch the fill to a stored org template or a deployment built-in, with
 *  whatever generators the caller supplied (none for a deterministic export). */
const fillReportDocx = async ({
  actor,
  templateRef,
  values,
  generators,
}: {
  actor: ExportActor;
  templateRef: ReportTemplateRef;
  values: Record<string, unknown>;
  generators: ReportAiGenerators;
}): Promise<FillReportResult> => {
  if (templateRef.type === "stored") {
    return await fillStoredTemplateDocx({
      templateId: templateRef.templateId,
      values,
      scopedDb: actor.scopedDb,
      organizationId: actor.organizationId,
      ...generators,
    });
  }

  const builtin = getBuiltinReportTemplate(templateRef.key);
  if (!builtin) {
    return { error: `Unknown built-in report template: ${templateRef.key}` };
  }
  const buffer = await builtin.loadBuffer();
  return await fillTemplateDocx({
    source: { name: builtin.name, fileName: `${builtin.name}.docx`, buffer },
    values,
    scopedDb: actor.scopedDb,
    organizationId: actor.organizationId,
    ...generators,
  });
};

const setExportStatus = async (
  actor: ExportActor,
  status: "running",
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — status bookkeeping on the already-audited export row.
    await tx
      .update(reportExports)
      .set({ status })
      .where(
        and(
          eq(reportExports.id, actor.exportId),
          eq(reportExports.workspaceId, actor.workspaceId),
        ),
      );
  });
};

const completeExport = async (
  actor: ExportActor,
  result: { resultEntityId?: SafeId<"entity">; resultS3Key?: string },
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — terminal bookkeeping on the already-audited export row (the
    // created document, in workspace mode, is audited by createEntityFromBuffer).
    await tx
      .update(reportExports)
      .set({
        status: "completed",
        error: null,
        resultEntityId: result.resultEntityId ?? null,
        resultS3Key: result.resultS3Key ?? null,
      })
      .where(
        and(
          eq(reportExports.id, actor.exportId),
          eq(reportExports.workspaceId, actor.workspaceId),
        ),
      );
  });
};

const markExportFailedRow = async (
  actor: ExportActor,
  message: string,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — failure bookkeeping on the already-audited export row.
    await tx
      .update(reportExports)
      .set({
        status: "failed",
        error: message.slice(0, ERROR_MESSAGE_MAX_CHARS),
      })
      .where(
        and(
          eq(reportExports.id, actor.exportId),
          eq(reportExports.workspaceId, actor.workspaceId),
        ),
      );
  });
};

/** Last-resort failure marker used from the worker `failed` handler and the
 *  job's own catch: rebrands the actor from raw job data. */
const markExportFailed = async (
  data: ReportExportJobData,
  message: string,
): Promise<void> => {
  const actor = brandActor(data);
  await markExportFailedRow(actor, message);
};
