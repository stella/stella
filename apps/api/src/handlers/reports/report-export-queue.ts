import { panic, Result } from "better-result";
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
import { and, eq, inArray } from "drizzle-orm";

import { reportExports } from "@/api/db/schema";
import type { ReportExportFormat, ReportTemplateRef } from "@/api/db/schema";
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
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { errorTag } from "@/api/lib/errors/utils";
import { scanUpload } from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { convertToPdf } from "@/api/lib/files/gotenberg";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { REPORT_EXPORT_QUEUE_NAME } from "@/api/lib/report-export-enqueue";
import type { ReportExportJobData } from "@/api/lib/report-export-enqueue";
import { listPendingReportExportNotifications } from "@/api/lib/report-export-notification-recovery";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { brandPersistedReportExportId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import { recordTemplateUse } from "@/api/lib/templates/record-use";
import type { FillDiagnosticSources } from "@/api/lib/templates/template-fill-completion";
import {
  decideTemplateFillCompletion,
  describeFillShortfall,
  fillDiagnosticsOf,
} from "@/api/lib/templates/template-fill-completion";
import type {
  AiFillCollaborators,
  MissingRequiredField,
} from "@/api/lib/templates/template-fill-service";
import {
  fillStoredTemplateDocx,
  fillTemplateDocx,
} from "@/api/lib/templates/template-fill-service";
import { parseStoredViewLayout } from "@/api/lib/views-schema";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const WORKER_CONCURRENCY = 2;
const ERROR_MESSAGE_MAX_CHARS = 1000;
const DOCX_TO_PDF_ERROR = "Failed to convert the report to PDF.";
const NOTIFICATION_RECONCILE_INTERVAL_MS = 60_000;
const REPORT_SOURCE_UNAVAILABLE = "The report source is no longer available.";

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

export const initReportExportWorker = ({ db }: BullMqWorkerContext) => {
  const workerConnection = createBullMqConnection({
    storeClass: "durable-coordination",
  });

  const worker = new BullMqWorker<ReportExportJobData>(
    REPORT_EXPORT_QUEUE_NAME,
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
    const { actors, suppressed } =
      await listPendingReportExportNotifications(db);
    // db-await-in-loop: one claim-and-notify transaction per pending actor; the pending read caps actors at REPORT_EXPORT_NOTIFICATION_RECONCILE_LIMIT
    const results = await Promise.all(
      actors.map(async (actorKey) => await notifyStatus(brandActor(actorKey))),
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
    queues: [REPORT_EXPORT_QUEUE_NAME] as const,
    close: async () => {
      await closeNotificationReconcile();
      await worker.close();
    },
  };
};

type ReportExportActor = RootRunActor<"reportExport"> & {
  exportId: SafeId<"reportExport">;
};
type ExportActor = ReportExportActor;

type ReportExportActorKey = Pick<
  ReportExportJobData,
  "exportId" | "organizationId" | "userId" | "workspaceId"
>;

const brandActor = (data: ReportExportActorKey): ExportActor => {
  const actor = createRootRunActor(
    { ...data, runId: data.exportId },
    brandPersistedReportExportId,
  );
  return { ...actor, exportId: actor.runId };
};

const notifyStatus = async (actor: ExportActor) =>
  await notifyReportExportStatus({
    exportId: actor.exportId,
    organizationId: actor.organizationId,
    scopedDb: actor.writeDb,
    userId: actor.userId,
    workspaceId: actor.workspaceId,
  });

const processReportExportJob = async (
  data: ReportExportJobData,
): Promise<void> => {
  await processReportExport(brandActor(data), data);
};

export const processReportExport = async (
  actor: ExportActor,
  data: Pick<ReportExportJobData, "aiNarrative" | "format">,
): Promise<void> => {
  const { exportId } = actor;

  const row = await actor.writeDb((tx) =>
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
    await notifyStatus(actor);
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
    await markExportFailedRow(actor, toExportErrorMessage(outcome.error));
    await notifyStatus(actor);
    return;
  }
  await notifyStatus(actor);
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
  // The report is filled from a stored template whose content the scan never
  // saw in this combination, so the filled output is scanned like an upload.
  const scanned = await scanUpload({
    bytes: new Uint8Array(docx),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: "report.docx",
  });
  if (Result.isError(scanned)) {
    return Result.err(scanned.error);
  }
  const result = await convertToPdf(scanned.value);
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

  // Everything the report is built from is read under the requester's
  // current membership.
  const workspace = await actor.inputSafeDb((tx) =>
    tx.query.workspaces.findFirst({
      where: { id: { eq: actor.workspaceId } },
      columns: { name: true },
    }),
  );
  if (Result.isError(workspace)) {
    await markExportFailedRow(actor, toExportErrorMessage(workspace.error));
    return;
  }
  if (workspace.value === undefined) {
    await markExportFailedRow(actor, REPORT_SOURCE_UNAVAILABLE);
    return;
  }
  const workspaceName = workspace.value.name;

  const dataResult = await buildReportData({
    safeDb: actor.inputSafeDb,
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
  const orgAIConfigResult = aiNarrative
    ? await actor.writeDb(async (tx) => await loadOrgAISettings(tx, actor))
    : Result.ok(null);
  if (Result.isError(orgAIConfigResult)) {
    await markExportFailedRow(actor, orgAIConfigResult.error.message);
    return;
  }
  const generators =
    orgAIConfigResult.value === null
      ? {}
      : buildReportAiGenerators({ actor, ...orgAIConfigResult.value });
  const filled = await fillReport({
    actor,
    templateRef: row.templateRef,
    report: dataResult.value,
    generators,
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
      scopedDb: actor.writeDb,
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
      encryption: serverBuiltFileEncryption(),
    });
    if (Result.isError(created)) {
      await markExportFailedRow(actor, created.error.message);
      return;
    }
    await completeExport(
      actor,
      {
        type: "workspace",
        entityId: created.value.entityId,
        fieldId: created.value.fieldId,
      },
      filled.usedTemplateId,
    );
    return;
  }

  // Download mode: write under the root exports/ prefix (S3 lifecycle prefix
  // filters anchor at the key start, so the scratch prefix must lead the key;
  // org/workspace segments keep the key tenant-scoped); the status endpoint
  // presigns it and names the download from the stored key's extension.
  const key = `exports/${actor.organizationId}/${actor.workspaceId}/${actor.exportId}.${delivery.ext}`;
  await writeS3ObjectWithRetry(
    {
      contentType: delivery.mimeType,
      data: delivery.buffer,
      key,
    },
    { type: "lifecycle-prefix", prefix: "exports/" },
  );
  await completeExport(
    actor,
    { type: "download", s3Key: key },
    filled.usedTemplateId,
  );
};

type FillReportResult =
  | {
      templateName: string;
      fileName: string;
      buffer: Buffer;
      /** The stored template whose use the completed export records; absent
       *  for a built-in. Recorded with the completion, so a failed export
       *  leaves the template's usage statistics untouched. */
      usedTemplateId?: SafeId<"template"> | undefined;
    }
  | { error: string }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: unknown };

type FilledReportDocx =
  | ({
      templateName: string;
      fileName: string;
      file: ScannedFile;
    } & FillDiagnosticSources)
  | Exclude<FillReportResult, { buffer: Buffer }>;

/**
 * A report export has no reader to hand a partial document to, so it reads
 * the fill's completion decision under the strict policy: an unfilled
 * placeholder, a failed AI draft or an undecided AI condition fails the
 * export with each shortfall named, instead of completing a document with
 * that content missing.
 */
const toFillReportResult = (
  filled: FilledReportDocx,
  usedTemplateId?: SafeId<"template">,
): FillReportResult => {
  if (!("file" in filled)) {
    return filled;
  }
  const completion = decideTemplateFillCompletion({
    mode: "require_complete",
    diagnostics: fillDiagnosticsOf(filled),
  });
  if (completion.type === "rejected_partial") {
    return {
      error: `Report template fill incomplete; ${describeFillShortfall(completion.blocking)}`,
    };
  }
  return {
    templateName: filled.templateName,
    fileName: filled.fileName,
    buffer: Buffer.from(filled.file.bytes),
    usedTemplateId,
  };
};

const fillReport = async ({
  actor,
  templateRef,
  report,
  generators,
  aiNarrative,
  linkBase,
}: {
  actor: ExportActor;
  templateRef: ReportTemplateRef;
  report: AssembledReport;
  generators: ReportAiGenerators;
  aiNarrative: boolean;
  linkBase: ReportLinkBase | undefined;
}): Promise<FillReportResult> => {
  // Deterministic export: no generators (resolveAiFields is a no-op without a
  // generator) and no usage preflight. The template's {% if aiNarrative %}
  // sections are removed at fill time, so the unfilled AI-field placeholders
  // never survive into the output.

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
  // A spec report renders its narrative directly rather than through the fill
  // service, so it resolves the collaborators itself — and only when the
  // narrative is actually requested.
  const rendered = await renderReportSpec({
    spec: builtin.spec,
    report,
    prompts: builtin.prompts,
    generateAiValue: aiNarrative
      ? (await generators.aiCollaborators?.())?.generateAiValue
      : undefined,
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

/** The AI hooks passed into the fill pipeline; both are optional so a
 *  deterministic export can pass `{}`. */
type ReportAiGenerators = {
  aiCollaborators?:
    | (() => AiFillCollaborators | Promise<AiFillCollaborators>)
    | undefined;
  assertUsageAvailable?: (() => Promise<unknown>) | undefined;
};

/** Build the metered AI generators + usage preflight for a narrative export. */
const buildReportAiGenerators = ({
  actor,
  orgAIConfig,
  managedAIResidency,
}: {
  actor: ExportActor;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
}): ReportAiGenerators => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    usageMetering: {
      actionType: "chat",
      organizationId: actor.organizationId,
      safeDb: actor.writeSafeDb,
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
            safeDb: actor.writeSafeDb,
          })
      : undefined;

  const shared = {
    orgAIConfig,
    managedAIResidency,
    organizationId: actor.organizationId,
    skillContext: {
      organizationId: actor.organizationId,
      safeDb: actor.writeSafeDb,
      userId: actor.userId,
    },
    aiAnalytics,
    tenantWorkspaceIds: [actor.workspaceId],
  };
  return {
    // The fill service builds these only when the manifest declares an AI
    // field, so a deterministic export never reaches the model layer.
    aiCollaborators: () => ({
      generateAiValue: buildAiFieldGenerator(shared),
      decideAiCondition: buildAiConditionDecider(shared),
      adaptAiValue: buildAiOccurrenceAdapter(shared),
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
    return toFillReportResult(
      await fillStoredTemplateDocx({
        templateId: templateRef.templateId,
        values,
        scopedDb: actor.writeDb,
        organizationId: actor.organizationId,
        thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
        requiredFields: "enforce",
        // The export records use when it completes, not when the fill does.
        useRecording: "caller",
        ...generators,
      }),
      templateRef.templateId,
    );
  }

  const builtin = getBuiltinReportTemplate(templateRef.key);
  if (!builtin) {
    return { error: `Unknown built-in report template: ${templateRef.key}` };
  }
  if (builtin.kind === "spec") {
    // fillReport routes spec built-ins to renderSpecReport before reaching here.
    return { error: `Report template "${templateRef.key}" is not a DOCX.` };
  }
  const fileName = `${builtin.name}.docx`;
  // A built-in layout is server-built bytes, scanned like an upload before
  // the fill parses them.
  const scanned = await scanUpload({
    bytes: await builtin.loadBuffer(),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName,
  });
  if (Result.isError(scanned)) {
    return { error: scanned.error.message };
  }
  return toFillReportResult(
    await fillTemplateDocx({
      source: { name: builtin.name, fileName, file: scanned.value },
      values,
      scopedDb: actor.writeDb,
      organizationId: actor.organizationId,
      thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
      requiredFields: "enforce",
      ...generators,
    }),
  );
};

const setExportStatus = async (
  actor: ExportActor,
  status: "running",
): Promise<void> => {
  await actor.writeDb(async (tx) => {
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
      result satisfies never;
      return panic(`Unhandled result: ${String(result)}`);
  }
};

const completeExport = async (
  actor: ExportActor,
  result: CompletedExportResult,
  usedTemplateId: SafeId<"template"> | undefined,
): Promise<void> => {
  await actor.writeDb(async (tx) => {
    // A stored template is used by the export that completes, in the same
    // transaction, so a failed or rejected export never counts as a use.
    if (usedTemplateId !== undefined) {
      await recordTemplateUse({ tx, templateId: usedTemplateId });
    }
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
  await actor.writeDb(async (tx) => {
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
  await notifyStatus(actor);
};
