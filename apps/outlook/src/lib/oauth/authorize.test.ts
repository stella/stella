import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { OUTLOOK_SCOPES } from "@stll/api-contract/outlook-client";

import {
  buildAuthorizeUrl,
  buildCallbackMessage,
  buildDialogStartUrl,
  OUTLOOK_AUTH_CALLBACK_MESSAGE_TYPE,
  readCallbackMessage,
  readDialogStartTarget,
} from "@/lib/oauth/authorize";

const TASK_PANE = "https://outlook.example.test";
const ISSUER = "https://api.example.test/api/auth";

const authorizeUrl = buildAuthorizeUrl({
  authorizationEndpoint: "https://api.example.test/api/auth/oauth2/authorize",
  clientId:
    "https://api.example.test/v1/mcp/oauth/outlook-client-metadata.json",
  codeChallenge: "challenge",
  redirectUri: `${TASK_PANE}/auth/callback.html`,
  resource: "https://api.example.test/v1",
  state: "state-1",
});

const message = (fields: Record<string, string | null>): string =>
  JSON.stringify({
    code: null,
    error: null,
    iss: ISSUER,
    state: "state-1",
    type: OUTLOOK_AUTH_CALLBACK_MESSAGE_TYPE,
    ...fields,
  });

const read = (
  raw: string,
  overrides: Partial<Parameters<typeof readCallbackMessage>[0]> = {},
) =>
  readCallbackMessage({
    expectedIssuer: ISSUER,
    expectedOrigin: TASK_PANE,
    expectedState: "state-1",
    issuerRequired: true,
    origin: TASK_PANE,
    raw,
    ...overrides,
  });

const failureOf = (result: ReturnType<typeof read>): string | null =>
  Result.isError(result) ? result.error.failure : null;

describe("authorization request", () => {
  test("asks for the add-in's scopes on the API resource with S256 PKCE", () => {
    const url = new URL(authorizeUrl);

    expect(url.origin + url.pathname).toBe(
      "https://api.example.test/api/auth/oauth2/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id:
        "https://api.example.test/v1/mcp/oauth/outlook-client-metadata.json",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      prompt: "consent",
      redirect_uri: `${TASK_PANE}/auth/callback.html`,
      resource: "https://api.example.test/v1",
      response_type: "code",
      scope: OUTLOOK_SCOPES.join(" "),
      state: "state-1",
    });
  });

  test("starts the dialog on the task pane's origin", () => {
    const start = new URL(
      buildDialogStartUrl({ authorizeUrl, taskPaneOrigin: TASK_PANE }),
    );

    expect(start.origin).toBe(TASK_PANE);
    expect(start.pathname).toBe("/auth/start.html");
    expect(
      readDialogStartTarget({
        allowedOrigins: ["https://api.example.test"],
        location: start.toString(),
      }),
    ).toBe(authorizeUrl);
  });

  test("refuses to forward the dialog anywhere but an authorization request on a stella origin", () => {
    const startFor = (target: string) =>
      buildDialogStartUrl({ authorizeUrl: target, taskPaneOrigin: TASK_PANE });
    const allowedOrigins = ["https://api.example.test"];

    const elsewhere = new URL(authorizeUrl);
    elsewhere.host = "attacker.example";
    const plain = new URL(authorizeUrl);
    plain.searchParams.delete("code_challenge_method");
    const foreignCallback = new URL(authorizeUrl);
    foreignCallback.searchParams.set(
      "redirect_uri",
      "https://attacker.example/auth/callback.html",
    );

    for (const target of [
      elsewhere.toString(),
      plain.toString(),
      foreignCallback.toString(),
      "https://api.example.test/somewhere",
      "data:text/html,hello",
    ]) {
      expect(
        readDialogStartTarget({ allowedOrigins, location: startFor(target) }),
      ).toBeNull();
    }
    expect(
      readDialogStartTarget({
        allowedOrigins,
        location: `${TASK_PANE}/auth/start.html`,
      }),
    ).toBeNull();
  });
});

describe("callback message", () => {
  test("forwards only the authorization response fields", () => {
    const raw = buildCallbackMessage(
      `${TASK_PANE}/auth/callback.html?code=abc&state=state-1&iss=${encodeURIComponent(ISSUER)}&extra=secret`,
    );

    expect(JSON.parse(raw)).toEqual({
      code: "abc",
      error: null,
      iss: ISSUER,
      state: "state-1",
      type: OUTLOOK_AUTH_CALLBACK_MESSAGE_TYPE,
    });
    expect(Result.isOk(read(raw))).toBe(true);
  });

  test("bounds every forwarded field", () => {
    const raw = buildCallbackMessage(
      `${TASK_PANE}/auth/callback.html?code=${"a".repeat(10_000)}`,
    );
    const parsed: unknown = JSON.parse(raw);

    expect(parsed).toMatchObject({ code: "a".repeat(4096) });
  });

  test("redeems the code of this attempt", () => {
    const result = read(message({ code: "code-1" }));

    expect(Result.isOk(result) ? result.value : null).toBe("code-1");
  });

  test("refuses an answer from another origin", () => {
    expect(
      failureOf(
        read(message({ code: "code-1" }), {
          origin: "https://attacker.example",
        }),
      ),
    ).toBe("mismatched");
    expect(
      failureOf(read(message({ code: "code-1" }), { origin: undefined })),
    ).toBe("mismatched");
  });

  test("refuses an answer to another attempt", () => {
    expect(failureOf(read(message({ code: "code-1", state: "other" })))).toBe(
      "mismatched",
    );
    expect(failureOf(read(message({ code: "code-1", state: null })))).toBe(
      "mismatched",
    );
  });

  test("refuses an answer from another issuer", () => {
    expect(
      failureOf(
        read(
          message({ code: "code-1", iss: "https://other.example/api/auth" }),
        ),
      ),
    ).toBe("mismatched");
    expect(failureOf(read(message({ code: "code-1", iss: null })))).toBe(
      "mismatched",
    );
    expect(
      Result.isOk(
        read(message({ code: "code-1", iss: null }), { issuerRequired: false }),
      ),
    ).toBe(true);
  });

  test("reports a refusal and a malformed answer", () => {
    expect(failureOf(read(message({ error: "access_denied" })))).toBe("denied");
    expect(failureOf(read(message({})))).toBe("malformed");
    expect(failureOf(read("not json"))).toBe("malformed");
    expect(failureOf(read(JSON.stringify({ token: "session" })))).toBe(
      "malformed",
    );
  });
});
