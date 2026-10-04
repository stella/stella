/**
 * GitHub issue delivery for filed feedback reports.
 *
 * The issue body carries the sanitized report, its receipt, its context and
 * the server version, and nothing else. No reporter identity ever reaches
 * GitHub: who filed a report is private and lives in `feedback_reports` and in
 * the maintainer email. The receipt is what links a public issue back to the
 * private row.
 */

import { Result, TaggedError } from "better-result";

import type { FeedbackKind } from "@stll/api-contract/feedback";

import { githubWrite } from "@/api/lib/github/github-write";
import { githubMarkdown } from "@/api/lib/github/outbound-text";
import type {
  GithubSafeText,
  GithubSafeTitle,
} from "@/api/lib/github/outbound-text";

/** Applied to every filed issue so the maintainers can triage the stream. */
const GITHUB_FEEDBACK_LABEL = githubMarkdown`agent-feedback`;

/**
 * The tracker label each kind maps to. Total over `FeedbackKind`: a new kind
 * is a labelling decision, not a silent fall-through to the bug label.
 */
const GITHUB_LABEL_BY_KIND = {
  bug: githubMarkdown`🐞 bug`,
  idea: githubMarkdown`enhancement`,
  missing_capability: githubMarkdown`enhancement`,
  docs: githubMarkdown`docs`,
} as const satisfies Record<FeedbackKind, GithubSafeText>;

export class GithubDeliveryError extends TaggedError("GithubDeliveryError")<{
  message: string;
  cause?: unknown;
}> {}

export type GithubDeliveryConfig = { repo: string; token: string };

/**
 * Title and body are the reporter's text, so they arrive only as values the
 * GitHub outbound owner produced; a plain string does not type-check.
 */
type GithubIssueRequest = {
  title: GithubSafeTitle;
  body: GithubSafeText;
  kind: FeedbackKind;
};

/** Posts one issue and answers with its `html_url`. */
export type GithubIssueCreator = (input: {
  config: GithubDeliveryConfig;
  issue: GithubIssueRequest;
}) => Promise<Result<string, GithubDeliveryError>>;

const issueUrlFromResponse = (payload: unknown): string | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("html_url" in payload)
  ) {
    return undefined;
  }
  const { html_url: htmlUrl } = payload;
  return typeof htmlUrl === "string" ? htmlUrl : undefined;
};

export const createGithubFeedbackIssue: GithubIssueCreator = async ({
  config,
  issue,
}) => {
  const payload = await githubWrite({
    token: config.token,
    method: "POST",
    path: `repos/${config.repo}/issues`,
    body: {
      title: issue.title,
      body: issue.body,
      labels: [GITHUB_LABEL_BY_KIND[issue.kind], GITHUB_FEEDBACK_LABEL],
    },
  });
  if (Result.isError(payload)) {
    return Result.err(
      new GithubDeliveryError({
        message: payload.error.message,
        cause: payload.error,
      }),
    );
  }

  const url = issueUrlFromResponse(payload.value);
  return url === undefined
    ? Result.err(
        new GithubDeliveryError({
          message: "GitHub response carried no issue URL",
        }),
      )
    : Result.ok(url);
};
