import { describe, expect, test } from "bun:test";

import type { FeedbackReportInput } from "@stll/api-contract/feedback";

import {
  checkFeedbackApproval,
  createFeedbackApproval,
  FEEDBACK_APPROVAL_TTL_MS,
} from "@/api/mcp/feedback-approval";

const SECRET = "s".repeat(32);
const NOW = 1_800_000_000_000;

const report: FeedbackReportInput = {
  kind: "bug",
  area: "documents",
  title: "read_document answers with an empty body",
  whatHappened: "The call returned an empty string for a long PDF.",
  context: { client: "mcp", requestId: "req_01HZX8" },
};

const subject = {
  organizationId: "org_1",
  report,
  secret: SECRET,
  userId: "user_1",
};

const approval = createFeedbackApproval({ ...subject, now: NOW });

describe("feedback approval", () => {
  test("covers the prepared report for the same user and organization", () => {
    expect(checkFeedbackApproval({ ...subject, approval, now: NOW })).toBe(
      "valid",
    );
  });

  test("is independent of the report's key order", () => {
    const reordered: FeedbackReportInput = {
      context: { requestId: "req_01HZX8", client: "mcp" },
      whatHappened: report.whatHappened,
      title: report.title,
      area: report.area,
      kind: report.kind,
    };

    expect(
      checkFeedbackApproval({
        ...subject,
        report: reordered,
        approval,
        now: NOW,
      }),
    ).toBe("valid");
  });

  test("does not cover any change to the report", () => {
    for (const changed of [
      { ...report, whatHappened: "Something the human never saw." },
      { ...report, evidence: "Added after approval." },
      { ...report, context: { client: "mcp" as const } },
    ]) {
      expect(
        checkFeedbackApproval({
          ...subject,
          report: changed,
          approval,
          now: NOW,
        }),
      ).toBe("invalid");
    }
  });

  test("is bound to the user, the organization, and the secret", () => {
    for (const other of [
      { userId: "user_2" },
      { organizationId: "org_2" },
      { secret: "t".repeat(32) },
    ]) {
      expect(
        checkFeedbackApproval({ ...subject, ...other, approval, now: NOW }),
      ).toBe("invalid");
    }
  });

  test("expires after the approval window", () => {
    expect(
      checkFeedbackApproval({
        ...subject,
        approval,
        now: NOW + FEEDBACK_APPROVAL_TTL_MS + 1,
      }),
    ).toBe("expired");
  });

  test("rejects a forged expiry and malformed tokens", () => {
    const mac = approval.slice(approval.lastIndexOf(".") + 1);
    const extended = `fb1.${String(NOW + 10 * FEEDBACK_APPROVAL_TTL_MS)}.${mac}`;

    for (const token of [extended, "", "fb1", "fb1.x.y", `${approval}x`]) {
      expect(
        checkFeedbackApproval({ ...subject, approval: token, now: NOW }),
      ).toBe("invalid");
    }
  });
});
