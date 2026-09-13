import { describe, expect, test } from "bun:test";

import {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  FILE_SECURITY_REMEDIATION,
} from "@stll/api-contract";

import { fileSecurityRejection } from "@/api/lib/file-scan/rejection";

describe("file security rejection envelope", () => {
  test("names the attached-template rule and the safe remediation", () => {
    expect(
      fileSecurityRejection({
        verdict: "reject",
        findings: [
          {
            rule: "ooxml_attached_template",
            severity: "reject",
            message: "Document contains an external Word template link",
          },
        ],
      }),
    ).toEqual({
      code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
      hint: "Remove the attached Word template link and its source reference, then upload the sanitized copy.",
      issues: [
        {
          code: "ooxml_attached_template",
          message: "Document contains an external Word template link",
          path: "file",
          remediation: FILE_SECURITY_REMEDIATION.removeAttachedTemplate,
        },
      ],
      message:
        "File rejected by security rule ooxml_attached_template: " +
        "Document contains an external Word template link",
    });
  });

  test("does not offer a bypass when another malicious rule also matched", () => {
    const rejection = fileSecurityRejection({
      verdict: "reject",
      findings: [
        {
          rule: "ooxml_attached_template",
          severity: "reject",
          message: "Attached template",
        },
        {
          rule: "ooxml_activex",
          severity: "reject",
          message: "ActiveX",
        },
      ],
    });

    expect(rejection?.hint).toStartWith("Do not retry the same bytes");
    expect(rejection?.issues.at(1)?.remediation).toBeUndefined();
  });

  test("returns null when no rejecting finding exists", () => {
    expect(
      fileSecurityRejection({
        verdict: "warn",
        findings: [{ rule: "rule", severity: "warn", message: "Warning" }],
      }),
    ).toBeNull();
  });
});
