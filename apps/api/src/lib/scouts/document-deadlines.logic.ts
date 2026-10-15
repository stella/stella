import { panic } from "better-result";
import * as v from "valibot";

import { SIGNAL_SEVERITY } from "@stll/api-contract/signals";
import type { SignalSeverity } from "@stll/api-contract/signals";
import { failureGradeOf } from "@stll/errors";
import { DAY_IN_MS, parsePlainDate, Temporal } from "@stll/time";

import {
  AI_ERROR_KIND_FAILURE_REASON,
  classifyAIError,
} from "@/api/lib/ai-error";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";

export const DEADLINE_SCOUT_MAX_ATTEMPTS = 5;

/** Whether admission refused a scan for an exhausted period, and until when. */
export type DeadlineScanAdmission =
  | { type: "admitted" }
  | { type: "period_exhausted"; skippedUntil: Date };

/**
 * A scan refused for an exhausted period skips until that period resets. The
 * refusal names the reset of the budget it exhausted: the organization's
 * service period and the generic action period are configured apart.
 */
export const deadlineScanAdmission = (error: unknown): DeadlineScanAdmission =>
  ActionAdmissionError.is(error) && error.reason === "period_exhausted"
    ? {
        type: "period_exhausted",
        skippedUntil: new Date(
          error.retryAtMs ??
            panic("An action period refusal names its period's reset"),
        ),
      }
    : { type: "admitted" };

export const deadlineScoutFailureStatus = (
  attemptCount: number,
  error: unknown,
) => {
  const kind = classifyAIError(error);
  const grade =
    kind === "unknown"
      ? "unknown"
      : failureGradeOf(AI_ERROR_KIND_FAILURE_REASON[kind]);
  if (
    grade === "anticipated" ||
    grade === "client" ||
    attemptCount >= DEADLINE_SCOUT_MAX_ATTEMPTS
  ) {
    return "failed";
  }
  return "pending";
};

export const DEADLINE_TEXT_CAP_CHARS = 60_000;
export const DEADLINE_TEXT_MIN_CHARS = 200;
export const DEADLINE_MIN_CONFIDENCE = 0.6;
export const DEADLINE_MAX_ITEMS = 10;
export const DEADLINE_QUOTE_MAX_CHARS = 300;
/** Deadlines slightly in the past are still worth surfacing (missed ones). */
export const DEADLINE_PAST_GRACE_MS = 7 * DAY_IN_MS;

export const deadlineExtractionSchema = v.object({
  deadlines: v.pipe(
    v.array(
      v.object({
        label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
        dueDate: v.pipe(v.string(), v.isoDate()),
        quote: v.pipe(
          v.string(),
          v.trim(),
          v.minLength(1),
          v.maxLength(DEADLINE_QUOTE_MAX_CHARS),
        ),
        confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
      }),
    ),
    v.maxLength(DEADLINE_MAX_ITEMS),
  ),
});

export type ExtractedDeadline = v.InferOutput<
  typeof deadlineExtractionSchema
>["deadlines"][number];

export const DEADLINE_SYSTEM_PROMPT =
  "Extract explicit obligations with calendar dates from the legal document. " +
  `Return at most ${DEADLINE_MAX_ITEMS} dated deadlines, each with a short label, the due date as an ISO date, ` +
  "a short contiguous verbatim excerpt supporting that deadline, and a confidence from 0 to 1. " +
  `Each excerpt must fit within ${DEADLINE_QUOTE_MAX_CHARS} characters; quote only the relevant clause, not the whole sentence. ` +
  "Never paraphrase, join separate passages, or cut away a qualification that changes the obligation. " +
  "Ignore dates that are not deadlines (signature dates, references, past events).";

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/gu, " ").trim().toLowerCase();

/** The evidence guard: a quote the document does not contain is discarded. */
export const quoteOccursInText = (quote: string, text: string): boolean => {
  const needle = normalizeWhitespace(quote);
  if (needle.length === 0) {
    return false;
  }
  return normalizeWhitespace(text).includes(needle);
};

const isKeptDate = (dueDate: string, now: Date): boolean => {
  const due = parsePlainDate(dueDate);
  if (due === null) {
    return false;
  }
  return (
    due.toZonedDateTime("UTC").epochMilliseconds >=
    now.getTime() - DEADLINE_PAST_GRACE_MS
  );
};

/**
 * Keep only deadlines that are confident enough, not stale, and whose quote
 * the document really contains. The order of checks is cost-ascending.
 */
export const filterDeadlines = (
  deadlines: readonly ExtractedDeadline[],
  text: string,
  now: Date,
): ExtractedDeadline[] =>
  deadlines.filter(
    (deadline) =>
      deadline.confidence >= DEADLINE_MIN_CONFIDENCE &&
      isKeptDate(deadline.dueDate, now) &&
      quoteOccursInText(deadline.quote, text),
  );

export const deadlineSeverity = (
  dueDate: string,
  now: Date,
): SignalSeverity => {
  const due =
    Temporal.PlainDate.from(dueDate).toZonedDateTime("UTC").epochMilliseconds;
  const daysLeft = (due - now.getTime()) / DAY_IN_MS;
  if (daysLeft <= 7) {
    return SIGNAL_SEVERITY.CRITICAL;
  }
  if (daysLeft <= 30) {
    return SIGNAL_SEVERITY.WARNING;
  }
  return SIGNAL_SEVERITY.NOTICE;
};

export const deadlineDedupeKey = (
  sourceRunId: string,
  dueDate: string,
  quote: string,
): string => {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(normalizeWhitespace(quote));
  return `deadline:v1:${sourceRunId}:${dueDate}:${hasher.digest("hex")}`;
};

export const capText = (text: string): string =>
  text.length <= DEADLINE_TEXT_CAP_CHARS
    ? text
    : text.slice(0, DEADLINE_TEXT_CAP_CHARS);
