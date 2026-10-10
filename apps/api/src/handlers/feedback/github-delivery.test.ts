import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { FEEDBACK_LIMITS } from "@stll/api-contract/feedback";
import type { FeedbackReportInput } from "@stll/api-contract/feedback";

import { createGithubFeedbackIssue } from "@/api/handlers/feedback/github-delivery";
import {
  composeGithubIssueBody,
  composeGithubIssueTitle,
} from "@/api/handlers/feedback/report-body";
import { GITHUB_TITLE_MAX_LENGTH } from "@/api/lib/github/outbound-text";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const report: FeedbackReportInput = {
  kind: "bug",
  area: "templates",
  // Every sigil gains a zero-width space: 200 characters become 300 unless
  // the title is held to GitHub's limit after neutralizing.
  title: "@a".repeat(FEEDBACK_LIMITS.title / 2),
  whatHappened: "cc @octocat",
};

const sentTitle = (body: unknown): string | undefined =>
  typeof body === "object" &&
  body !== null &&
  "title" in body &&
  typeof body.title === "string"
    ? body.title
    : undefined;

const requestUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

type SentIssue = { url: string; body: unknown };

/** Files the report with fetch answering `response`; returns what was sent. */
const fileReport = async (
  response: Response,
): Promise<{
  result: Awaited<ReturnType<typeof createGithubFeedbackIssue>>;
  sent: SentIssue[];
}> => {
  const sent: SentIssue[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    asFetchMock(async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: requestUrl(input),
        body: JSON.parse(typeof init?.body === "string" ? init.body : "null"),
      });
      return response;
    }),
  );
  try {
    const result = await createGithubFeedbackIssue({
      config: { repo: "o/r", token: "t" },
      issue: {
        title: composeGithubIssueTitle(report),
        body: composeGithubIssueBody({
          receipt: "fb_1",
          report,
          serverVersion: "1.0.0",
        }),
        kind: report.kind,
      },
    });
    return { result, sent };
  } finally {
    fetchSpy.mockRestore();
  }
};

describe("createGithubFeedbackIssue", () => {
  test("posts the issue through the write helper within GitHub's limits", async () => {
    const { result, sent } = await fileReport(
      Response.json({ html_url: "https://github.test/o/r/issues/7" }),
    );

    expect(result.unwrap()).toBe("https://github.test/o/r/issues/7");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.github.com/repos/o/r/issues");
    expect(sent[0]?.body).toMatchObject({
      labels: ["🐞 bug", "agent-feedback"],
    });
    const title = sentTitle(sent[0]?.body);
    expect(title?.length).toBeLessThanOrEqual(GITHUB_TITLE_MAX_LENGTH);
    expect(title?.endsWith("…")).toBe(true);
  });

  test("a response without an issue URL is an error", async () => {
    const { result } = await fileReport(Response.json({}));
    expect(Result.isError(result)).toBe(true);
  });
});
