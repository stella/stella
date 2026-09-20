/**
 * Report-level sanitization: the one place every entry point runs a feedback
 * report through the redaction passes, so `prepare_feedback` shows the human
 * exactly the text `submit_feedback`, the web route and the public intake
 * store and deliver.
 *
 * `context.requestId` is deliberately not sanitized. It is the key a
 * maintainer correlates a report with server logs, and the secret passes would
 * eat a bare opaque id written in free text; it is validated against a narrow
 * character class instead and dropped when it does not match. `context.client`
 * is a picklist, so there is nothing in it to redact.
 */

import { FEEDBACK_LIMITS } from "@stll/api-contract/feedback";
import type {
  FeedbackReportContext,
  FeedbackReportInput,
} from "@stll/api-contract/feedback";

import { sanitizeFeedbackText } from "@/api/mcp/feedback-sanitize";

/**
 * Request ids are opaque tokens; anything outside this class is not one. The
 * same expression is advertised as the MCP input's `pattern` and as the
 * Elysia route's, so it is built flagless on purpose.
 */
// oxlint-disable-next-line require-unicode-regexp -- @valibot/to-json-schema rejects every regex flag, and the advertised `pattern` has to be the expression this reader runs
export const FEEDBACK_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const TEXT_FIELDS = [
  "title",
  "whatHappened",
  "expected",
  "steps",
  "evidence",
] as const;

const CONTEXT_TEXT_FIELDS = [
  "clientVersion",
  "route",
  "errorReference",
] as const;

type TextField = (typeof TEXT_FIELDS)[number];
type ContextTextField = (typeof CONTEXT_TEXT_FIELDS)[number];

/** Dotted paths the redaction passes can touch; `redactedFields` holds these. */
export type SanitizableFeedbackField =
  | TextField
  | `context.${ContextTextField}`;

export type SanitizedFeedbackReport = {
  report: FeedbackReportInput;
  redactions: number;
  redactedFields: SanitizableFeedbackField[];
};

const CAP_BY_TEXT_FIELD = {
  title: FEEDBACK_LIMITS.title,
  whatHappened: FEEDBACK_LIMITS.whatHappened,
  expected: FEEDBACK_LIMITS.expected,
  steps: FEEDBACK_LIMITS.steps,
  evidence: FEEDBACK_LIMITS.evidence,
} as const satisfies Record<TextField, number>;

/**
 * Redaction can lengthen a field (a 12-character token becomes
 * `[redacted-secret]`), so the stored value is capped after the passes rather
 * than trusting the pre-sanitization length the schema checked.
 */
const capped = (value: string, max: number): string =>
  Array.from(value).slice(0, max).join("");

export const sanitizeFeedbackReport = (
  input: FeedbackReportInput,
): SanitizedFeedbackReport => {
  const redactedFields: SanitizableFeedbackField[] = [];
  let redactions = 0;

  const runPass = (
    field: SanitizableFeedbackField,
    value: string,
    max: number,
  ): string => {
    const pass = sanitizeFeedbackText(value);
    if (pass.redactions > 0) {
      redactions += pass.redactions;
      redactedFields.push(field);
    }
    return capped(pass.text, max);
  };

  const report: FeedbackReportInput = {
    kind: input.kind,
    area: input.area,
    title: runPass("title", input.title, CAP_BY_TEXT_FIELD.title),
    whatHappened: runPass(
      "whatHappened",
      input.whatHappened,
      CAP_BY_TEXT_FIELD.whatHappened,
    ),
  };

  for (const field of ["expected", "steps", "evidence"] as const) {
    const value = input[field];
    if (value !== undefined && value.length > 0) {
      report[field] = runPass(field, value, CAP_BY_TEXT_FIELD[field]);
    }
  }

  const context = sanitizeContext(input.context, runPass);
  if (context !== undefined) {
    report.context = context;
  }

  return { report, redactions, redactedFields };
};

const sanitizeContext = (
  context: FeedbackReportContext | undefined,
  runPass: (
    field: SanitizableFeedbackField,
    value: string,
    max: number,
  ) => string,
): FeedbackReportContext | undefined => {
  if (context === undefined) {
    return undefined;
  }

  const sanitized: FeedbackReportContext = {};
  if (context.client !== undefined) {
    sanitized.client = context.client;
  }
  if (
    context.requestId !== undefined &&
    FEEDBACK_REQUEST_ID_PATTERN.test(context.requestId)
  ) {
    sanitized.requestId = context.requestId;
  }
  for (const field of CONTEXT_TEXT_FIELDS) {
    const value = context[field];
    if (value === undefined || value.length === 0) {
      continue;
    }
    const cleaned = runPass(
      `context.${field}`,
      value,
      FEEDBACK_LIMITS.contextField,
    );
    if (cleaned.length > 0) {
      sanitized[field] = cleaned;
    }
  }

  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
};

/** SHA-256 over the sanitized content: the dedupe identity of a report. */
export const feedbackFingerprint = (report: FeedbackReportInput): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        report.kind,
        report.area,
        report.title,
        report.whatHappened,
        report.expected ?? "",
        report.steps ?? "",
        report.evidence ?? "",
      ]),
    )
    .digest("hex");
