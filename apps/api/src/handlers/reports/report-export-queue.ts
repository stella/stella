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
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import {
  brandPersistedReportExportId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { parseViewLayout } from "@/api/lib/views-schema";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "report-exports";
const JOB_NAME = "export-report";
const WORKER_CONCURRENCY = 2;
// One attempt: the fill runs metered AI and (in workspace mode) creates a
// document; a BullMQ retry would double both. Failures are persisted on the row.
const JOB_ATTEMPTS = 1;
const ERROR_MESSAGE_MAX_CHARS = 1000;

type ReportExportJobData = {
  exportId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

export type EnqueueReportExportArgs = {
  exportId: SafeId<"reportExport">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
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
}: EnqueueReportExportArgs): Promise<void> => {
  await getQueue().add(
    JOB_NAME,
    { exportId, workspaceId, organizationId, userId },
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
    try: async () => await runExport({ actor, row }),
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

const runExport = async ({
  actor,
  row,
}: {
  actor: ExportActor;
  row: ExportRow;
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
  });
  if (Result.isError(dataResult)) {
    await markExportFailedRow(actor, dataResult.error.message);
    return;
  }

  const orgAIConfig = await loadOrgAIConfig(actor.organizationId);
  const filled = await fillReport({
    actor,
    templateRef: row.templateRef,
    reportData: dataResult.value,
    orgAIConfig,
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

  const fileName = sanitizeFilename(
    `${workspaceName} - ${filled.templateName}.docx`,
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
      buffer: filled.buffer,
      fileName,
      mimeType: DOCX_MIME_TYPE,
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

  // Download mode: write under the org/workspace-scoped exports/ prefix (a
  // bucket lifecycle rule expires this prefix); the status endpoint presigns it.
  const key = `${actor.organizationId}/${actor.workspaceId}/exports/${actor.exportId}.docx`;
  await getS3().write(key, new Uint8Array(filled.buffer));
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
}: {
  actor: ExportActor;
  templateRef: ReportTemplateRef;
  reportData: Record<string, unknown>;
  orgAIConfig: OrgAIConfig | null;
}): Promise<FillReportResult> => {
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
  const generators = {
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

  if (templateRef.type === "stored") {
    return await fillStoredTemplateDocx({
      templateId: templateRef.templateId,
      values: reportData,
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
    values: reportData,
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
