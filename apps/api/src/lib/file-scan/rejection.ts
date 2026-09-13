import {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  FILE_SECURITY_REMEDIATION,
} from "@stll/api-contract";
import type {
  ApiFileSecurityIssue,
  ApiFileSecurityRejection,
} from "@stll/api-contract";
import { ATTACHED_TEMPLATE_SECURITY_RULE } from "@stll/docx-utils";

import type { ScanResult } from "@/api/lib/file-scan/types";

export const fileSecurityRejection = (
  scanResult: ScanResult,
): ApiFileSecurityRejection | null => {
  const rejected = scanResult.findings.filter(
    ({ severity }) => severity === "reject",
  );
  const firstRejection = rejected.at(0);
  if (firstRejection === undefined) {
    return null;
  }

  const attachedTemplateOnly = rejected.every(
    ({ rule }) => rule === ATTACHED_TEMPLATE_SECURITY_RULE,
  );
  const issues = rejected.map(({ message, rule }): ApiFileSecurityIssue => ({
    code: rule,
    message,
    path: "file",
    ...(rule === ATTACHED_TEMPLATE_SECURITY_RULE
      ? { remediation: FILE_SECURITY_REMEDIATION.removeAttachedTemplate }
      : {}),
  }));
  const message =
    rejected.length === 1
      ? `File rejected by security rule ${firstRejection.rule}: ${firstRejection.message}`
      : `File rejected by security rules: ${rejected.map(({ rule }) => rule).join(", ")}`;

  return {
    code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
    hint: attachedTemplateOnly
      ? "Remove the attached Word template link and its source reference, then upload the sanitized copy."
      : "Do not retry the same bytes. Review the listed security issues and upload a safe copy.",
    issues,
    message,
  };
};
