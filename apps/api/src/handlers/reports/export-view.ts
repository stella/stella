/**
 * Enqueue a view→report export.
 *
 * Validates the source view (must be a table view in this workspace), the
 * requested template (a deployment built-in or a stored `report`-kind org
 * template), and the row cap EARLY (a cheap indexed count) so an oversized view
 * rejects before any job is queued. Inserts a `report_exports` row, records an
 * audit event, enqueues the background job, and returns the export id for the
 * frontend to poll.
 *
 * Ownership ids come from server-validated sources: `workspaceId` from the
 * SafeId path param, `requestedBy` from the session user. `viewId` and a stored
 * `templateId` come from the body but are validated against the workspace / org
 * (RLS) before use.
 */

import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { reportExports } from "@/api/db/schema";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import { isReportRowCountOverCap } from "@/api/handlers/reports/build-report-data";
import { getBuiltinReportTemplate } from "@/api/handlers/reports/builtin-templates";
import { enqueueReportExport } from "@/api/handlers/reports/report-export-queue";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { parseViewLayout } from "@/api/lib/views-schema";

const templateRefSchema = t.Union([
  t.Object({ type: t.Literal("builtin"), key: t.String({ minLength: 1 }) }),
  t.Object({
    type: t.Literal("stored"),
    templateId: tSafeId("template"),
  }),
]);

const config = {
  permissions: { workspace: ["read"], entity: ["create"] },
  params: workspaceParams({}),
  body: t.Object({
    templateRef: templateRefSchema,
    viewId: tSafeId("workspaceView"),
    mode: t.Union([t.Literal("workspace"), t.Literal("download")]),
    // Output format. The fill pipeline always builds a DOCX; `pdf` converts it
    // via Gotenberg before delivery. Optional for back-compat; absent defaults
    // to docx (also matches Elysia's optional-UnionEnum coercion to the first
    // literal). The frontend always sends it explicitly.
    format: t.Optional(t.Union([t.Literal("docx"), t.Literal("pdf")])),
    // Include the template's AI-drafted narrative (executive + per-contract
    // summaries). Optional for back-compat; absent defaults to on. When false
    // the worker skips every model call and the template's {{#if aiNarrative}}
    // sections are removed, so the export is fast and deterministic.
    aiNarrative: t.Optional(t.Boolean()),
  }),
} satisfies HandlerConfig;

const exportViewReport = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    user,
    session,
    body,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;

    const view = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaceViews.findFirst({
          where: {
            id: { eq: body.viewId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true, layout: true },
        }),
      ),
    );
    if (!view) {
      return Result.err(
        new HandlerError({ status: 404, message: "View not found" }),
      );
    }

    const layout = parseViewLayout(view.layout);
    if (layout.type !== "table") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Only table views can be exported to a report.",
        }),
      );
    }

    // Validate the template ref before queuing.
    const templateRef = body.templateRef;
    if (templateRef.type === "builtin") {
      if (!getBuiltinReportTemplate(templateRef.key)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: `Unknown built-in report template: ${templateRef.key}`,
          }),
        );
      }
    } else {
      const template = yield* Result.await(
        // RLS scopes this to the caller's organization.
        safeDb((tx) =>
          tx.query.templates.findFirst({
            where: { id: { eq: templateRef.templateId } },
            columns: { id: true, kind: true },
          }),
        ),
      );
      if (!template || template.kind !== "report") {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Report template not found.",
          }),
        );
      }
    }

    // Cheap early row-cap check: an indexed count over the view's filters, no
    // fields loaded. Exceeding the cap is a typed error, never a truncated job.
    const countResult = yield* Result.await(
      queryEntities({
        safeDb,
        workspaceId,
        currentUserId: user.id,
        currentOrganizationId: organizationId,
        filters: layout.filters,
        sorts: layout.sorts,
        limit: 1,
        fieldMode: "visible",
        fieldIds: [],
        excludedKinds: ["folder", "task"],
        includeTotalCount: true,
      }),
    );
    if (
      countResult.totalCount !== null &&
      isReportRowCountOverCap(countResult.totalCount)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "This view has too many rows to export as a report; narrow its filters first.",
        }),
      );
    }

    const exportId = yield* Result.await(
      safeDb(async (tx) => {
        const [inserted] = await tx
          .insert(reportExports)
          .values({
            workspaceId,
            requestedBy: user.id,
            templateRef: body.templateRef,
            viewId: view.id,
            layout,
            mode: body.mode,
            status: "queued",
          })
          .returning({ id: reportExports.id });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.REPORT_EXPORT,
          resourceId: inserted?.id ?? "",
          metadata: {
            mode: body.mode,
            templateType: body.templateRef.type,
          },
        });

        return inserted?.id ?? null;
      }),
    );

    if (!exportId) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to create the export record.",
        }),
      );
    }

    const enqueued = await Result.tryPromise({
      try: async () =>
        await enqueueReportExport({
          exportId,
          workspaceId,
          organizationId,
          userId: user.id,
          format: body.format ?? "docx",
          aiNarrative: body.aiNarrative ?? true,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(enqueued)) {
      // Mark the row failed so a never-enqueued export cannot sit "queued"
      // forever; the status endpoint then surfaces the failure.
      yield* Result.await(
        safeDb(async (tx) => {
          // audit: skip — status bookkeeping on the export row audited at insert.
          await tx
            .update(reportExports)
            .set({ status: "failed", error: "Failed to enqueue the export." })
            .where(eq(reportExports.id, exportId));
        }),
      );
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to enqueue the report export.",
          cause: enqueued.error,
        }),
      );
    }

    return Result.ok({ exportId });
  },
);

export default exportViewReport;
