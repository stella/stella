/**
 * Markdown rendering of a stored feedback report for the public issue tracker.
 *
 * What is NOT here is the point: no user id, no organization id, no reporter
 * email, no instance name. Who filed a report is private and lives in
 * `feedback_reports` and in the maintainer email; the receipt is the only
 * thread between the two.
 */

import type {
  FeedbackReportContext,
  FeedbackReportInput,
} from "@stll/api-contract/feedback";

type ContextLabelKey = keyof FeedbackReportContext;

/**
 * The heading each context key is rendered under. Total over the context
 * shape: a key added to the contract without a label here is a compile error,
 * not a silently dropped line.
 */
const CONTEXT_LABELS = {
  client: "Client",
  clientVersion: "Client version",
  requestId: "Request id",
  route: "Route",
  errorReference: "Error reference",
} as const satisfies Record<ContextLabelKey, string>;

// Derived from the label map rather than hand-listed, so a context key added
// to the contract is rendered as soon as it has a label and cannot be dropped
// by an out-of-date second list.
const CONTEXT_KEYS = Object.keys(CONTEXT_LABELS).filter(
  (key): key is ContextLabelKey => key in CONTEXT_LABELS,
);

const section = (heading: string, body: string | undefined): string[] =>
  body === undefined || body.length === 0
    ? []
    : [`## ${heading}`, "", body, ""];

const contextLines = (context: FeedbackReportContext | undefined): string[] => {
  if (context === undefined) {
    return [];
  }
  const lines = CONTEXT_KEYS.flatMap((key) => {
    const value = context[key];
    return value === undefined ? [] : [`- ${CONTEXT_LABELS[key]}: ${value}`];
  });
  return lines.length === 0 ? [] : ["## Context", "", ...lines, ""];
};

const ZERO_WIDTH_SPACE = "\u200B";

/**
 * The server files issues under the maintainers' token, so reporter text must
 * not be able to ping accounts or cross-link issues through it. A zero-width
 * space after the sigil keeps the text readable and stops the tracker from
 * resolving `@name` and `#123`.
 */
export const neutralizeGithubReferences = (text: string): string =>
  text.replaceAll(
    /[@#](?=[A-Za-z0-9])/gu,
    (sigil) => `${sigil}${ZERO_WIDTH_SPACE}`,
  );

export type ComposeGithubIssueBodyOptions = {
  receipt: string;
  report: FeedbackReportInput;
  serverVersion: string;
};

export const composeGithubIssueBody = ({
  receipt,
  report,
  serverVersion,
}: ComposeGithubIssueBodyOptions): string =>
  neutralizeGithubReferences(
    [
      `- Kind: ${report.kind}`,
      `- Area: ${report.area}`,
      `- Receipt: ${receipt}`,
      `- Server version: ${serverVersion}`,
      "",
      ...section("What happened", report.whatHappened),
      ...section("Expected", report.expected),
      ...section("Steps", report.steps),
      ...section("Evidence", report.evidence),
      ...contextLines(report.context),
      "---",
      "Filed through the stella feedback pipeline. Content is sanitized " +
        "server-side; the reporter's identity is held privately and is not " +
        "published here. Quote the receipt to correlate.",
    ].join("\n"),
  );
