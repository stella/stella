/**
 * Binds `submit_feedback` to the exact report `prepare_feedback` returned.
 *
 * `prepare_feedback` signs the caller, the organization, an expiry, and a
 * digest of the sanitized report; `submit_feedback` recomputes the digest from
 * the report it is handed and refuses a mismatch. A caller can therefore only
 * send bytes that came back from `prepare_feedback`, for the same user and
 * organization, within the approval window: content cannot be swapped between
 * the report a human was shown and the one that is sent.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { FeedbackReportInput } from "@stll/api-contract/feedback";
import { stableStringify } from "@stll/stable-stringify";

const APPROVAL_PREFIX = "fb1";
const APPROVAL_PATTERN = /^fb1\.([0-9]{1,16})\.[A-Za-z0-9_-]{43}$/u;

/** How long a prepared report stays submittable. */
export const FEEDBACK_APPROVAL_TTL_MS = 60 * 60 * 1000;

type ApprovalSubject = {
  organizationId: string;
  report: FeedbackReportInput;
  secret: string;
  userId: string;
};

const reportDigest = (report: FeedbackReportInput): string =>
  createHash("sha256").update(stableStringify(report)).digest("base64url");

const signature = ({
  expiresAt,
  organizationId,
  report,
  secret,
  userId,
}: ApprovalSubject & { expiresAt: number }): string =>
  createHmac("sha256", secret)
    .update(
      [
        APPROVAL_PREFIX,
        userId,
        organizationId,
        String(expiresAt),
        reportDigest(report),
      ].join(":"),
    )
    .digest("base64url");

export const createFeedbackApproval = (
  subject: ApprovalSubject & { now: number },
): string => {
  const expiresAt = subject.now + FEEDBACK_APPROVAL_TTL_MS;
  return `${APPROVAL_PREFIX}.${String(expiresAt)}.${signature({ ...subject, expiresAt })}`;
};

export type FeedbackApprovalCheck = "valid" | "invalid" | "expired";

export const checkFeedbackApproval = (
  subject: ApprovalSubject & { approval: string; now: number },
): FeedbackApprovalCheck => {
  const expiresAtText = APPROVAL_PATTERN.exec(subject.approval)?.at(1);
  if (expiresAtText === undefined) {
    return "invalid";
  }
  const expiresAt = Number(expiresAtText);
  const expected = `${APPROVAL_PREFIX}.${expiresAtText}.${signature({ ...subject, expiresAt })}`;
  if (
    expected.length !== subject.approval.length ||
    !timingSafeEqual(Buffer.from(subject.approval), Buffer.from(expected))
  ) {
    return "invalid";
  }
  return subject.now > expiresAt ? "expired" : "valid";
};
