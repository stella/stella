import { Result } from "better-result";
import { t } from "elysia";

import type { MatterActivityFilters } from "@stll/api-contract/matter-activity";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { escapeCSV } from "@/api/lib/csv";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";

import {
  matterActivityFilterQueryProperties,
  toMatterActivityFilters,
} from "./matter-activity-query";
import { readOverviewActivityPage } from "./read-overview-activity.query";
import type { MatterActivityItem } from "./read-overview-activity.query";

const MATTER_ACTIVITY_EXPORT_FORMATS = ["csv", "json"] as const;
type MatterActivityExportFormat =
  (typeof MATTER_ACTIVITY_EXPORT_FORMATS)[number];

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  transport: {
    type: "file-response",
    response: {
      mediaTypes: [
        "text/csv; charset=utf-8",
        "application/json; charset=utf-8",
      ],
    },
    alternative: {
      type: "none",
      reason:
        "no capability returns the matter's complete filtered activity history",
    },
  },
  query: t.Object({
    ...matterActivityFilterQueryProperties,
    format: t.UnionEnum([...MATTER_ACTIVITY_EXPORT_FORMATS]),
  }),
} satisfies HandlerConfig;

const matterActivityCsv = (items: readonly MatterActivityItem[]): string => {
  const rows = [
    [
      "Time",
      "Actor",
      "Actor type",
      "Action",
      "Category",
      "Target type",
      "Target",
      "Origin",
      "Run ID",
      "Event ID",
    ].join(","),
  ];

  for (const item of items) {
    rows.push(
      [
        item.activityAt,
        item.performer.name ?? "",
        item.performer.type,
        item.action,
        item.category,
        item.target.kind,
        item.target.name ?? "",
        [item.trigger.type, item.trigger.source].filter(Boolean).join(":"),
        item.runId ?? "",
        item.id,
      ]
        .map(escapeCSV)
        .join(","),
    );
  }

  return `${rows.join("\r\n")}\r\n`;
};

const matterActivityJson = ({
  exportedAt,
  filters,
  items,
}: {
  exportedAt: string;
  filters: MatterActivityFilters;
  items: readonly MatterActivityItem[];
}): string =>
  JSON.stringify({
    version: 1,
    exportedAt,
    filters,
    items,
  });

const exportOverviewActivity = createSafeHandler(
  config,
  async function* ({ query, recordAuditEvent, safeDb, session, workspaceId }) {
    const filters = toMatterActivityFilters(query);
    const page = yield* Result.await(
      readOverviewActivityPage({
        cursor: null,
        filters,
        limit: LIMITS.exportRowLimit + 1,
        organizationId: session.activeOrganizationId,
        safeDb,
        workspaceId,
      }),
    );

    if (page.items.length > LIMITS.exportRowLimit) {
      return Result.err(
        new HandlerError({
          status: 413,
          message: `The export exceeds ${LIMITS.exportRowLimit} rows. Narrow the filters and try again.`,
        }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: workspaceId,
          metadata: { format: query.format, rowCount: page.items.length },
        });
      }),
    );

    return Result.ok(
      matterActivityExportResponse({
        exportedAt: new Date().toISOString(),
        filters,
        format: query.format,
        items: page.items,
      }),
    );
  },
);

const matterActivityExportResponse = ({
  exportedAt,
  filters,
  format,
  items,
}: {
  exportedAt: string;
  filters: MatterActivityFilters;
  format: MatterActivityExportFormat;
  items: readonly MatterActivityItem[];
}): Response =>
  secureDocumentResponse({
    body:
      format === "csv"
        ? matterActivityCsv(items)
        : matterActivityJson({ exportedAt, filters, items }),
    contentType:
      format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/json; charset=utf-8",
    disposition: "attachment",
    fileName: sanitizeFilename(`matter-activity.${format}`),
  });

export default exportOverviewActivity;
