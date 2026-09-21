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

import { fetchWithTimeout } from "@/api/lib/fetch";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/** Applied to every filed issue so the maintainers can triage the stream. */
const GITHUB_FEEDBACK_LABEL = "agent-feedback";

/**
 * The tracker label each kind maps to. Total over `FeedbackKind`: a new kind
 * is a labelling decision, not a silent fall-through to the bug label.
 */
const GITHUB_LABEL_BY_KIND = {
  bug: "🐞 bug",
  idea: "enhancement",
  missing_capability: "enhancement",
  docs: "docs",
} as const satisfies Record<FeedbackKind, string>;

export class GithubDeliveryError extends TaggedError("GithubDeliveryError")<{
  message: string;
  cause?: unknown;
}> {}

export type GithubDeliveryConfig = { repo: string; token: string };

type GithubIssueRequest = {
  title: string;
  body: string;
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
  const response = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(`${GITHUB_API_BASE}/repos/${config.repo}/issues`, {
        method: "POST",
        timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: [GITHUB_LABEL_BY_KIND[issue.kind], GITHUB_FEEDBACK_LABEL],
        }),
      }),
    catch: (cause) =>
      new GithubDeliveryError({
        message: "GitHub issue creation failed",
        cause,
      }),
  });
  if (Result.isError(response)) {
    return response;
  }
  if (!response.value.ok) {
    // The status alone: a GitHub error body can echo the request back, and
    // this message reaches telemetry.
    return Result.err(
      new GithubDeliveryError({
        message: `GitHub refused the issue with status ${response.value.status}`,
      }),
    );
  }

  const payload = await Result.tryPromise({
    try: async (): Promise<unknown> => await response.value.json(),
    catch: (cause) =>
      new GithubDeliveryError({
        message: "GitHub returned an unreadable body",
        cause,
      }),
  });
  if (Result.isError(payload)) {
    return payload;
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
