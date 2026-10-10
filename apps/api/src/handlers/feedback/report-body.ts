/**
 * Markdown rendering of a stored feedback report for the public issue tracker.
 *
 * What is NOT here is the point: no user id, no organization id, no reporter
 * email, no instance name. Who filed a report is private and lives in
 * `feedback_reports` and in the maintainer email; the receipt is the only
 * thread between the two.
 *
 * Every value that is not authored here goes through the GitHub outbound owner
 * (`@/api/lib/github/outbound-text`): reporter text renders as code, so it can
 * neither ping accounts, cross-link issues, nor reshape the body around it.
 */

import type {
  FeedbackReportContext,
  FeedbackReportInput,
} from "@stll/api-contract/feedback";

import {
  githubMarkdown,
  joinGithubMarkdownLines,
  toGithubUserInline,
  toGithubUserText,
  toGithubUserTitle,
} from "@/api/lib/github/outbound-text";
import type {
  GithubSafeText,
  GithubSafeTitle,
} from "@/api/lib/github/outbound-text";

type ContextLabelKey = keyof FeedbackReportContext;

/**
 * The heading each context key is rendered under. Total over the context
 * shape: a key added to the contract without a label here is a compile error,
 * not a silently dropped line.
 */
const CONTEXT_LABELS = {
  client: githubMarkdown`Client`,
  clientVersion: githubMarkdown`Client version`,
  requestId: githubMarkdown`Request id`,
  route: githubMarkdown`Route`,
  errorReference: githubMarkdown`Error reference`,
} as const satisfies Record<ContextLabelKey, GithubSafeText>;

// Derived from the label map rather than hand-listed, so a context key added
// to the contract is rendered as soon as it has a label and cannot be dropped
// by an out-of-date second list.
const CONTEXT_KEYS = Object.keys(CONTEXT_LABELS).filter(
  (key): key is ContextLabelKey => key in CONTEXT_LABELS,
);

const BLANK_LINE = githubMarkdown``;

const section = (
  heading: GithubSafeText,
  body: string | undefined,
): GithubSafeText[] =>
  body === undefined || body.length === 0
    ? []
    : [
        githubMarkdown`## ${heading}`,
        BLANK_LINE,
        toGithubUserText(body),
        BLANK_LINE,
      ];

const contextLines = (
  context: FeedbackReportContext | undefined,
): GithubSafeText[] => {
  if (context === undefined) {
    return [];
  }
  const lines = CONTEXT_KEYS.flatMap((key) => {
    const value = context[key];
    return value === undefined
      ? []
      : [
          githubMarkdown`- ${CONTEXT_LABELS[key]}: ${toGithubUserInline(value)}`,
        ];
  });
  return lines.length === 0
    ? []
    : [githubMarkdown`## Context`, BLANK_LINE, ...lines, BLANK_LINE];
};

/** The issue title: the report's title with every live sigil broken. */
export const composeGithubIssueTitle = (
  report: FeedbackReportInput,
): GithubSafeTitle => toGithubUserTitle(report.title);

export type ComposeGithubIssueBodyOptions = {
  receipt: string;
  report: FeedbackReportInput;
  serverVersion: string;
};

export const composeGithubIssueBody = ({
  receipt,
  report,
  serverVersion,
}: ComposeGithubIssueBodyOptions): GithubSafeText =>
  joinGithubMarkdownLines([
    githubMarkdown`- Kind: ${toGithubUserInline(report.kind)}`,
    githubMarkdown`- Area: ${toGithubUserInline(report.area)}`,
    githubMarkdown`- Receipt: ${toGithubUserInline(receipt)}`,
    githubMarkdown`- Server version: ${toGithubUserInline(serverVersion)}`,
    BLANK_LINE,
    ...section(githubMarkdown`What happened`, report.whatHappened),
    ...section(githubMarkdown`Expected`, report.expected),
    ...section(githubMarkdown`Steps`, report.steps),
    ...section(githubMarkdown`Evidence`, report.evidence),
    ...contextLines(report.context),
    githubMarkdown`---`,
    githubMarkdown`Filed through the stella feedback pipeline. Content is sanitized server-side; the reporter's identity is held privately and is not published here. Quote the receipt to correlate.`,
  ]);
