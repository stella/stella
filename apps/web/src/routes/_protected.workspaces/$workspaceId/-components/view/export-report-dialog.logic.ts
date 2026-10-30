import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";

import type { WebApiRoutes } from "@/lib/api";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";

export type ReportExportRequest =
  WebApiRoutes["workspaces"][":workspaceId"]["reports"]["export"]["post"]["body"];

export type ReportExportSubmission =
  | { type: "ready" }
  | { type: "submitting" }
  | { type: "refused"; request: ReportExportRequest; error: unknown };

// The narrative is the only model work in an export: a refusal that retrying
// will not clear offers the export without it.
export const reportExportWithoutAi = (
  request: ReportExportRequest,
  error: unknown,
) => {
  const code = actionAdmissionOutcome(error)?.code;
  if (
    request.aiNarrative !== true ||
    (code !== ACTION_ADMISSION_CODES.notEnabled &&
      code !== ACTION_ADMISSION_CODES.featureDisabled)
  ) {
    return undefined;
  }
  return { ...request, aiNarrative: false };
};
