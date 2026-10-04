import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import {
  githubWrite,
  serializeGithubWriteBody,
} from "@/api/lib/github/github-write";
import {
  githubMarkdown,
  toGithubUserText,
  toGithubUserTitle,
} from "@/api/lib/github/outbound-text";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

type SentRequest = { url: string; init: RequestInit | undefined };

const requestUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

const issueBody = {
  title: toGithubUserTitle("cc @octocat"),
  body: toGithubUserText("hi @octocat"),
  labels: [githubMarkdown`docs`],
};

/** Posts `issueBody` with fetch answering `response`; returns what was sent. */
const postIssue = async (
  response: Response,
): Promise<{
  result: Awaited<ReturnType<typeof githubWrite>>;
  sent: SentRequest[];
}> => {
  const sent: SentRequest[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    asFetchMock(async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: requestUrl(input), init });
      return response;
    }),
  );
  try {
    const result = await githubWrite({
      token: "secret",
      method: "POST",
      path: "repos/o/r/issues",
      body: issueBody,
    });
    return { result, sent };
  } finally {
    fetchSpy.mockRestore();
  }
};

describe("githubWrite", () => {
  test("a write body admits only values the outbound owner produced", () => {
    const sendRaw = async () =>
      await githubWrite({
        token: "t",
        method: "POST",
        path: "repos/o/r/issues",
        // @ts-expect-error a raw string is not a GitHub write value
        body: { title: "cc @octocat" },
      });
    const sendRawList = async () =>
      await githubWrite({
        token: "t",
        method: "POST",
        path: "repos/o/r/issues",
        // @ts-expect-error raw strings are not GitHub write values in a list
        body: { labels: ["@octocat"] },
      });
    expect([typeof sendRaw, typeof sendRawList]).toEqual([
      "function",
      "function",
    ]);
  });

  test("serializes each safe value as its text", () => {
    expect(JSON.parse(serializeGithubWriteBody(issueBody))).toEqual({
      title: "cc @​octocat",
      body: "```text\nhi @octocat\n```",
      labels: ["docs"],
    });
  });

  test("sends the request to the REST path and answers with the JSON", async () => {
    const { result, sent } = await postIssue(
      Response.json({ html_url: "https://github.test/o/r/issues/1" }),
    );
    expect(result.unwrap()).toEqual({
      html_url: "https://github.test/o/r/issues/1",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.github.com/repos/o/r/issues");
    expect(sent[0]?.init?.method).toBe("POST");
    expect(new Headers(sent[0]?.init?.headers).get("authorization")).toBe(
      "Bearer secret",
    );
    expect(sent[0]?.init?.body).toBe(serializeGithubWriteBody(issueBody));
  });

  test("a refusal reports the status, never the response body", async () => {
    const { result } = await postIssue(
      new Response("echo: cc @octocat", { status: 422 }),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe(
        "GitHub refused the request with status 422",
      );
    }
  });

  test("an unreadable response is an error", async () => {
    const { result } = await postIssue(new Response("not json"));
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe("GitHub returned an unreadable body");
    }
  });
});
