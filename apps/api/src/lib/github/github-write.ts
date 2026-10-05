/**
 * The one place the API writes to GitHub.
 *
 * Every request that creates or changes something on GitHub goes through
 * `githubWrite`, and its body admits only values the outbound owner produced
 * (`outbound-text.ts`): user text as `GithubSafeText` / `GithubSafeTitle`, and
 * code-authored fields built with the `githubMarkdown` tag. A plain string
 * does not type-check, so no caller can send raw text, imported owner or not.
 * `outbound-text.guard.test.ts` fails any other GitHub write in the API: a
 * request with a method other than GET or HEAD, or any Octokit use.
 */

import { Result, TaggedError } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import type {
  GithubSafeText,
  GithubSafeTitle,
} from "@/api/lib/github/outbound-text";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

export class GithubWriteError extends TaggedError("GithubWriteError")<{
  message: string;
  cause?: unknown;
}> {}

/** A field of a GitHub write body: a safe value, or a list of safe values. */
type GithubWriteValue =
  | GithubSafeText
  | GithubSafeTitle
  | readonly GithubSafeText[];

/** A GitHub write body; every field is a value the outbound owner produced. */
export type GithubWriteBody = Readonly<Record<string, GithubWriteValue>>;

export type GithubWriteRequest = {
  token: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  /** The REST path after the API root (`repos/o/r/issues`), built by code. */
  path: string;
  body: GithubWriteBody;
};

const isSafeTextList = (
  value: GithubWriteValue,
): value is readonly GithubSafeText[] => Array.isArray(value);

const toJsonValue = (value: GithubWriteValue): string | string[] => {
  if (isSafeTextList(value)) {
    return value.map((item) => item.markdown);
  }
  return "text" in value ? value.text : value.markdown;
};

/** The JSON GitHub receives for a write body. */
export const serializeGithubWriteBody = (body: GithubWriteBody): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, toJsonValue(value)]),
    ),
  );

/** Sends one write and answers with GitHub's parsed JSON response. */
export const githubWrite = async (
  request: GithubWriteRequest,
): Promise<Result<unknown, GithubWriteError>> => {
  const response = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(`${GITHUB_API_BASE}/${request.path}`, {
        method: request.method,
        timeout: { type: "idle", ms: GITHUB_REQUEST_TIMEOUT_MS },
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${request.token}`,
          "content-type": "application/json",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        body: serializeGithubWriteBody(request.body),
      }),
    catch: (cause) =>
      new GithubWriteError({ message: "GitHub request failed", cause }),
  });
  if (Result.isError(response)) {
    return response;
  }
  if (!response.value.ok) {
    // The status alone: a GitHub error body can echo the request back, and
    // this message reaches telemetry.
    return Result.err(
      new GithubWriteError({
        message: `GitHub refused the request with status ${response.value.status}`,
      }),
    );
  }
  return await Result.tryPromise({
    try: async (): Promise<unknown> => await response.value.json(),
    catch: (cause) =>
      new GithubWriteError({
        message: "GitHub returned an unreadable body",
        cause,
      }),
  });
};
