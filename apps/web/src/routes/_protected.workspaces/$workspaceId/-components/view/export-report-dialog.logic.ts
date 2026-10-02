import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";

import type { WebApiRoutes } from "@/lib/eden-client";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";

export type ReportExportRequest =
  WebApiRoutes["workspaces"][":workspaceId"]["reports"]["export"]["post"]["body"];

export type ReportExportSubmission =
  | { type: "ready" }
  | { type: "submitting" }
  | { type: "refused"; request: ReportExportRequest; error: unknown };

export const reportExportWithoutAi = (
  request: ReportExportRequest,
  error: unknown,
) => {
  if (
    request.aiNarrative !== true ||
    actionAdmissionOutcome(error)?.code !== ACTION_ADMISSION_CODES.notEnabled
  ) {
    return undefined;
  }
  return { ...request, aiNarrative: false };
};
