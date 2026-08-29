import { describe, expect, test } from "bun:test";

import { parseBetterAuthSignInReplayArgs } from "@/api/scripts/better-auth-sign-in-replay";

describe("parseBetterAuthSignInReplayArgs", () => {
  test("accepts an https origin and a non-negative sample size", () => {
    const parsed = parseBetterAuthSignInReplayArgs([
      "--oauth-base-url",
      "https://api.example.invalid/",
      "--session-sample",
      "200",
    ]);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      expect(parsed.value).toEqual({
        oauthBaseUrl: "https://api.example.invalid",
        sessionSample: 200,
      });
    }
  });

  test.each([
    [[]],
    [
      [
        "--oauth-base-url",
        "http://api.example.invalid",
        "--session-sample",
        "1",
      ],
    ],
    [
      [
        "--oauth-base-url",
        "https://api.example.invalid/path",
        "--session-sample",
        "1",
      ],
    ],
    [
      [
        "--oauth-base-url",
        "https://api.example.invalid",
        "--session-sample",
        "-1",
      ],
    ],
    [
      [
        "--oauth-base-url",
        "https://api.example.invalid",
        "--session-sample",
        "many",
      ],
    ],
    [
      [
        "--oauth-base-url",
        "https://api.example.invalid",
        "--session-sample",
        "1001",
      ],
    ],
    [
      [
        "--oauth-base-url",
        "https://api.example.invalid",
        "--session-sample",
        "1",
        "extra",
      ],
    ],
  ])("rejects %j", (args) => {
    expect(parseBetterAuthSignInReplayArgs(args).status).toBe("error");
  });
});
