/**
 * Feedback submission builder shared by both agent surfaces.
 *
 * anonymize runs fully local and makes no network calls, so feedback is never
 * sent from here. Instead this module sanitizes the agent-authored title/body
 * and returns a prefilled GitHub new-issue URL (plus an equivalent `gh` command)
 * that a human opens and submits under their own account. The human approval and
 * the absence of any network call are the real controls; the sanitizer is a
 * coarse safety net. This module stays runtime-free.
 */

import {
  sanitizeFeedbackText,
  type SanitizeFeedbackResult,
} from "./feedback-sanitize";

export const FEEDBACK_KINDS = [
  "bug",
  "feature_request",
  "docs",
  "other",
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const MAX_FEEDBACK_TITLE_CHARS = 200;
export const MAX_FEEDBACK_BODY_CHARS = 8000;

const GITHUB_REPO = "stella/anonymize";
const GITHUB_ISSUE_LABEL = "agent-feedback";
const GITHUB_NEW_ISSUE_URL = `https://github.com/${GITHUB_REPO}/issues/new`;
// A conservative cap: browsers accept much longer, but keeping the prefilled URL
// small avoids client-side truncation surprises. The full sanitized body is
// always returned separately, so nothing is lost.
const MAX_GITHUB_ISSUE_URL_CHARS = 7500;
const GITHUB_BODY_TRUNCATION_MARKER =
  "\n\n[body truncated — paste the rest manually]";
const HIGH_SURROGATE_START = 55_296;
const HIGH_SURROGATE_END = 56_319;

type FeedbackInput = {
  kind: FeedbackKind;
  title: string;
  body: string;
};

export type FeedbackSubmission = {
  title: string;
  /** Fully sanitized body with a provenance footer; nothing is lost to URL truncation. */
  sanitizedBody: string;
  /** Total redactions across title and body, for the human to gauge stripping. */
  redactions: number;
  /** Prefilled new-issue URL the human opens and submits. */
  issueUrl: string;
  /** Equivalent `gh` command, safe to paste verbatim. */
  ghCommand: string;
};

const composeFeedbackBody = (body: string, kind: FeedbackKind): string =>
  `${body}\n\n---\n_Filed via stella-anonymize feedback (agent-assisted, sanitized). Kind: ${kind}._`;

const buildGithubIssueUrl = (title: string, body: string): string => {
  const params = new URLSearchParams({
    title,
    body,
    labels: GITHUB_ISSUE_LABEL,
  });
  return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
};

const sliceWithoutDanglingHighSurrogate = (
  value: string,
  end: number,
): string => {
  const sliced = value.slice(0, end);
  const last = sliced.codePointAt(sliced.length - 1);
  return last !== undefined &&
    last >= HIGH_SURROGATE_START &&
    last <= HIGH_SURROGATE_END
    ? sliced.slice(0, -1)
    : sliced;
};

/**
 * Prefilled issue URL bounded to `MAX_GITHUB_ISSUE_URL_CHARS`. When the full
 * body overflows, the URL carries a truncated body with a paste-the-rest marker;
 * the caller still returns the full sanitized body separately.
 */
const buildBoundedGithubIssueUrl = (
  title: string,
  composedBody: string,
): string => {
  const full = buildGithubIssueUrl(title, composedBody);
  if (full.length <= MAX_GITHUB_ISSUE_URL_CHARS) {
    return full;
  }
  for (let keep = composedBody.length; keep > 0; keep -= 128) {
    const candidate = buildGithubIssueUrl(
      title,
      sliceWithoutDanglingHighSurrogate(composedBody, keep) +
        GITHUB_BODY_TRUNCATION_MARKER,
    );
    if (candidate.length <= MAX_GITHUB_ISSUE_URL_CHARS) {
      return candidate;
    }
  }
  // Even an empty body overflows (an outsized title): fall back to marker-only.
  return buildGithubIssueUrl(title, GITHUB_BODY_TRUNCATION_MARKER);
};

/** POSIX single-quote escaping so the gh command is safe to paste verbatim. */
const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const buildGhCommand = (title: string, body: string): string =>
  [
    "gh issue create",
    `--repo ${GITHUB_REPO}`,
    `--label ${GITHUB_ISSUE_LABEL}`,
    `--title ${shellSingleQuote(title)}`,
    `--body ${shellSingleQuote(body)}`,
  ].join(" ");

/**
 * Sanitize the title and body, then build the prefilled GitHub submission. Pure:
 * no I/O and no network. The caller presents the result for a human to submit.
 */
export const buildFeedbackSubmission = ({
  body,
  kind,
  title,
}: FeedbackInput): FeedbackSubmission => {
  const cleanTitle: SanitizeFeedbackResult = sanitizeFeedbackText(title);
  const cleanBody = sanitizeFeedbackText(body);
  const composedBody = composeFeedbackBody(cleanBody.text, kind);
  return {
    title: cleanTitle.text,
    sanitizedBody: composedBody,
    redactions: cleanTitle.redactions + cleanBody.redactions,
    issueUrl: buildBoundedGithubIssueUrl(cleanTitle.text, composedBody),
    ghCommand: buildGhCommand(cleanTitle.text, composedBody),
  };
};
