import * as v from "valibot";

import { SIGNAL_SEVERITY } from "@stll/api-contract/signals";
import type { SignalSeverity } from "@stll/api-contract/signals";
import { DAY_IN_MS } from "@stll/time";

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
  "Return only dated deadlines, each with a short label, the due date as an ISO date, " +
  "a verbatim quote of the sentence that states it, and a confidence from 0 to 1. " +
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
  const due = new Date(`${dueDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(due)) {
    return false;
  }
  return due >= now.getTime() - DEADLINE_PAST_GRACE_MS;
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
  const due = new Date(`${dueDate}T00:00:00.000Z`).getTime();
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
  entityId: string,
  dueDate: string,
  label: string,
): string => {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(label.trim().toLowerCase());
  return `deadline:${entityId}:${dueDate}:${hasher.digest("hex")}`;
};

export const capText = (text: string): string =>
  text.length <= DEADLINE_TEXT_CAP_CHARS
    ? text
    : text.slice(0, DEADLINE_TEXT_CAP_CHARS);
