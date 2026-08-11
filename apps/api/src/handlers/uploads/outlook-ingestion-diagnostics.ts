import { Result } from "better-result";
import { t } from "elysia";

import {
  OUTLOOK_INGESTION_OUTCOMES,
  OUTLOOK_INGESTION_PLATFORMS,
  OUTLOOK_INGESTION_RETRY_STAGES,
  OUTLOOK_HOST_VERSION_PATTERN,
  type OutlookIngestionDiagnostic,
  type OutlookIngestionOutcome,
  type OutlookIngestionRetryStage,
} from "@stll/api-contract";

import { getAnalytics } from "@/api/lib/analytics/client";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";

export const outlookIngestionDiagnosticSchema = t.Object(
  {
    aggregateAttachmentBytes: t.Nullable(t.Integer({ minimum: 0 })),
    attachmentCount: t.Integer({ minimum: 0 }),
    host: t.Nullable(t.Literal("Outlook")),
    hostVersion: t.Nullable(t.RegExp(OUTLOOK_HOST_VERSION_PATTERN)),
    mailboxRequirementSetSupported: t.Nullable(t.Boolean()),
    outcome: t.UnionEnum(OUTLOOK_INGESTION_OUTCOMES),
    platform: t.Nullable(t.UnionEnum(OUTLOOK_INGESTION_PLATFORMS)),
    retryStage: t.UnionEnum(OUTLOOK_INGESTION_RETRY_STAGES),
    traceId: t.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export type OutlookIngestionOperation =
  | "abort"
  | "finalize"
  | "reconcile"
  | "reserve";

type CaptureOutlookIngestionOptions = {
  diagnostic: OutlookIngestionDiagnostic | undefined;
  durableState: string;
  operation: OutlookIngestionOperation;
  organizationId: SafeId<"organization">;
  outcome?: OutlookIngestionOutcome;
  retryStage?: OutlookIngestionRetryStage;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Emit only the explicitly allowlisted, content-free Outlook metadata.
 * Server-owned tenant and operation fields override client observations.
 */
export const captureOutlookIngestion = ({
  diagnostic,
  durableState,
  operation,
  organizationId,
  outcome,
  retryStage,
  userId,
  workspaceId,
}: CaptureOutlookIngestionOptions): void => {
  if (!diagnostic) {
    return;
  }

  const captured = Result.try({
    try: () =>
      getAnalytics().capture({
        distinctId: userId,
        event: SERVER_ANALYTICS_EVENTS.outlookEmailIngestion,
        properties: {
          attachment_count: diagnostic.attachmentCount,
          durable_state: durableState,
          operation,
          organization_id: organizationId,
          outcome: outcome ?? diagnostic.outcome,
          retry_stage: retryStage ?? diagnostic.retryStage,
          trace_id: diagnostic.traceId,
          workspace_id: workspaceId,
          ...(diagnostic.aggregateAttachmentBytes === null
            ? {}
            : {
                aggregate_attachment_bytes:
                  diagnostic.aggregateAttachmentBytes,
              }),
          ...(diagnostic.host ? { host: diagnostic.host } : {}),
          ...(diagnostic.hostVersion
            ? { host_version: diagnostic.hostVersion }
            : {}),
          ...(diagnostic.mailboxRequirementSetSupported === null
            ? {}
            : {
                mailbox_requirement_set_supported:
                  diagnostic.mailboxRequirementSetSupported,
              }),
          ...(diagnostic.platform ? { platform: diagnostic.platform } : {}),
        },
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(captured)) {
    logger.warn("outlook_ingestion.telemetry_failed", {
      operation,
      traceId: diagnostic.traceId,
    });
  }
};
