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
import { Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { reportExports } from "@/api/db/schema";
import type { ReportTemplateRef } from "@/api/db/schema";
import { env } from "@/api/env";
import type { AssembledReport } from "@/api/handlers/reports/build-report-data";
import { buildReportData } from "@/api/handlers/reports/build-report-data";
import type { BuiltinReportTemplate } from "@/api/handlers/reports/builtin-templates";
import { getBuiltinReportTemplate } from "@/api/handlers/reports/builtin-templates";
import { notifyReportExportStatus } from "@/api/handlers/reports/report-export-notification";
import type { ReportLinkBase } from "@/api/handlers/reports/spec/render-report-spec";
import {
  hasNarrativeSection,
  renderReportSpec,
} from "@/api/handlers/reports/spec/render-report-spec";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { errorTag } from "@/api/lib/errors/utils";
import { convertToPdf } from "@/api/lib/files/gotenberg";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { listPendingReportExportNotifications } from "@/api/lib/report-export-notification-recovery";
import { recoverStuckReportExports } from "@/api/lib/report-export-recovery";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import {
  brandPersistedReportExportId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import type { MissingRequiredField } from "@/api/lib/templates/template-fill-service";
import {
  fillStoredTemplateDocx,
  fillTemplateDocx,
} from "@/api/lib/templates/template-fill-service";
import { parseStoredViewLayout } from "@/api/lib/views-schema";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "report-exports";
const JOB_NAME = "export-report";
const WORKER_CONCURRENCY = 2;
// One attempt: the fill runs metered AI and (in workspace mode) creates a
// document; a BullMQ retry would double both. Failures are persisted on the row.
const JOB_ATTEMPTS = 1;
const ERROR_MESSAGE_MAX_CHARS = 1000;
const DOCX_TO_PDF_ERROR = "Failed to convert the report to PDF.";
const NOTIFICATION_RECONCILE_INTERVAL_MS = 60_000;

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

const getQueue = createLazyBullMqQueue<ReportExportJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

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

  worker.on(
    "error",
    createQueueWorkerErrorLogger("report_export.worker_error"),
  );

  const runNotificationReconcile = async (): Promise<void> => {
    const { actors, suppressed } = await listPendingReportExportNotifications();
    const results = await Promise.all(
      actors.map(
        async (actorKey) =>
          await notifyReportExportStatus(brandActor(actorKey)),
      ),
    );
    const finalized = results.filter(
      ({ status }) =>
        status !== "skipped" &&
        status !== "claim_failed" &&
        status !== "finalize_failed",
    ).length;
    const reconciled = finalized + suppressed;
    if (reconciled > 0) {
      logger.info("report_export.notifications_reconciled", {
        count: String(reconciled),
      });
    }
  };
  const closeNotificationReconcile = startNonOverlappingInterval({
    intervalMs: NOTIFICATION_RECONCILE_INTERVAL_MS,
    run: runNotificationReconcile,
    onError: (error) => {
      captureError(error, {
        operation: "report_export.notification.reconcile",
      });
    },
  });

  logger.info("report_export.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    close: async () => {
      await closeNotificationReconcile();
      await worker.close();
    },
  };
};

type ExportActor = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  exportId: SafeId<"reportExport">;
};

type ReportExportActorKey = Pick<
  ReportExportJobData,
  "exportId" | "organizationId" | "userId" | "workspaceId"
>;

const brandActor = (data: ReportExportActorKey): ExportActor => {
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
      columns: {
        status: true,
        mode: true,
        templateRef: true,
        layout: true,
        viewId: true,
      },
    }),
  );

  // Only a freshly queued row runs; a re-delivered job (or one already terminal)
  // is a no-op so the export never double-runs its AI/document creation.
  if (!row) {
    return;
  }
  if (row.status !== "queued") {
    await notifyReportExportStatus(actor);
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
    return;
  }
  await notifyReportExportStatus(actor);
};

type ExportRow = {
  mode: "workspace" | "download";
  templateRef: ReportTemplateRef;
  layout: unknown;
  /** Source view; null once the view is deleted (citation links then have no
   *  route to point at and are omitted). */
  viewId: SafeId<"workspaceView"> | null;
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
    return Result.err(result.error);
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
  const layout = parseStoredViewLayout(row.layout);
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
    report: dataResult.value,
    orgAIConfig,
    aiNarrative,
    linkBase:
      row.viewId === null
        ? undefined
        : {
            appUrl: env.FRONTEND_URL.replace(/\/$/u, ""),
            workspaceId: actor.workspaceId,
            viewId: row.viewId,
          },
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
  if ("requiredFieldsRejection" in filled) {
    // A report template declares a required field the report data never
    // supplies — a template-authoring bug, not a user-correctable input.
    const names = filled.requiredFieldsRejection.map(
      (field) => field.label ?? field.path,
    );
    await markExportFailedRow(
      actor,
      `Report template is missing required values: ${names.join(", ")}`,
    );
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
        execution: {
          performer: {
            id: "report-export",
            name: "Report export",
            type: "service",
          },
          trigger: {
            source: "action",
            type: "user_dispatch",
            userId: actor.userId,
          },
        },
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
      type: "workspace",
      entityId: created.value.entityId,
      fieldId: created.value.fieldId,
    });
    return;
  }

  // Download mode: write under the root exports/ prefix (S3 lifecycle prefix
  // filters anchor at the key start, so the scratch prefix must lead the key;
  // org/workspace segments keep the key tenant-scoped); the status endpoint
  // presigns it. The stored key's extension is what the status endpoint uses
  // to name the download, so no format column is needed on the export row.
  const key = `exports/${actor.organizationId}/${actor.workspaceId}/${actor.exportId}.${delivery.ext}`;
  await writeS3ObjectWithRetry({
    contentType: delivery.mimeType,
    data: delivery.buffer,
    key,
  });
  await completeExport(actor, { type: "download", s3Key: key });
};

type FillReportResult =
  | { templateName: string; fileName: string; buffer: Buffer }
  | { error: string }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: unknown };

const fillReport = async ({
  actor,
  templateRef,
  report,
  orgAIConfig,
  aiNarrative,
  linkBase,
}: {
  actor: ExportActor;
  templateRef: ReportTemplateRef;
  report: AssembledReport;
  orgAIConfig: OrgAIConfig | null;
  aiNarrative: boolean;
  linkBase: ReportLinkBase | undefined;
}): Promise<FillReportResult> => {
  // Deterministic export: no generators (resolveAiFields is a no-op without a
  // generator) and no usage preflight. The template's {{#if aiNarrative}}
  // sections are removed at fill time, so the unfilled AI-field placeholders
  // never survive into the output.
  const generators = aiNarrative
    ? buildReportAiGenerators({ actor, orgAIConfig })
    : {};

  if (templateRef.type === "builtin") {
    const builtin = getBuiltinReportTemplate(templateRef.key);
    if (builtin?.kind === "spec") {
      return await renderSpecReport({
        builtin,
        report,
        generators,
        aiNarrative,
        linkBase,
      });
    }
  }

  return await fillReportDocx({
    actor,
    templateRef,
    // The AI-visible object only; `links` never reaches the fill pipeline.
    values: report.data,
    generators,
  });
};

/** Render a spec built-in. The usage preflight runs only when a narrative
 *  section can actually call the generator, mirroring the DOCX fill's gate. */
const renderSpecReport = async ({
  builtin,
  report,
  generators,
  aiNarrative,
  linkBase,
}: {
  builtin: Extract<BuiltinReportTemplate, { kind: "spec" }>;
  report: AssembledReport;
  generators: ReportAiGenerators;
  aiNarrative: boolean;
  linkBase: ReportLinkBase | undefined;
}): Promise<FillReportResult> => {
  if (
    aiNarrative &&
    generators.assertUsageAvailable &&
    hasNarrativeSection(builtin.spec.sections)
  ) {
    const usageRejection = await generators.assertUsageAvailable();
    if (usageRejection !== null) {
      return { usageRejection };
    }
  }
  const rendered = await renderReportSpec({
    spec: builtin.spec,
    report,
    prompts: builtin.prompts,
    generateAiValue: generators.generateAiValue,
    aiNarrative,
    linkBase,
  });
  if (Result.isError(rendered)) {
    return { error: rendered.error.message };
  }
  return {
    templateName: builtin.name,
    fileName: `${builtin.name}.docx`,
    buffer: rendered.value,
  };
};

/** The AI generator bundle passed into the fill pipeline; every field is
 *  optional so a deterministic export can pass `{}`. */
type ReportAiGenerators = {
  generateAiValue?: ReturnType<typeof buildAiFieldGenerator> | undefined;
  decideAiCondition?: ReturnType<typeof buildAiConditionDecider> | undefined;
  adaptAiValue?: ReturnType<typeof buildAiOccurrenceAdapter> | undefined;
  assertUsageAvailable?: (() => Promise<unknown>) | undefined;
};

/** Build the metered AI generators + usage preflight for a narrative export. */
const buildReportAiGenerators = ({
  actor,
  orgAIConfig,
}: {
  actor: ExportActor;
  orgAIConfig: OrgAIConfig | null;
}): ReportAiGenerators => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
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
    orgAIConfig || hasTanStackInstanceProvider()
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
      tenantWorkspaceIds: [actor.workspaceId],
    }),
    decideAiCondition: buildAiConditionDecider({
      orgAIConfig,
      organizationId: actor.organizationId,
      skillContext,
      aiAnalytics,
      tenantWorkspaceIds: [actor.workspaceId],
    }),
    adaptAiValue: buildAiOccurrenceAdapter({
      orgAIConfig,
      organizationId: actor.organizationId,
      skillContext,
      aiAnalytics,
      tenantWorkspaceIds: [actor.workspaceId],
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
  if (builtin.kind === "spec") {
    // fillReport routes spec built-ins to renderSpecReport before reaching here.
    return { error: `Report template "${templateRef.key}" is not a DOCX.` };
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

type CompletedExportResult =
  | {
      type: "workspace";
      entityId: SafeId<"entity">;
      fieldId: SafeId<"field">;
    }
  | { type: "download"; s3Key: string };

const completedExportValues = (result: CompletedExportResult) => {
  switch (result.type) {
    case "workspace":
      return {
        resultEntityId: result.entityId,
        resultFieldId: result.fieldId,
        resultS3Key: null,
      };
    case "download":
      return {
        resultEntityId: null,
        resultFieldId: null,
        resultS3Key: result.s3Key,
      };
    default:
      return result satisfies never;
  }
};

const completeExport = async (
  actor: ExportActor,
  result: CompletedExportResult,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — terminal bookkeeping on the already-audited export row (the
    // created document, in workspace mode, is audited by createEntityFromBuffer).
    await tx
      .update(reportExports)
      .set({
        status: "completed",
        error: null,
        ...completedExportValues(result),
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
          inArray(reportExports.status, ["queued", "running"]),
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
  await notifyReportExportStatus(actor);
};
