import {
  afterAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import * as v from "valibot";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { createAuth } from "@/api/lib/auth";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();
const testState = createTestState({ file: import.meta.path, config: env });
// timeout: the shared auth database is created once per file, which outlasts the default.
setDefaultTimeout(120_000);

testState.beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const origin = "http://localhost:3001";
const CLIENT_ID = "token-exchange-google-client";

const idToken = (email: string) => {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "RS256", typ: "JWT" }),
    part({
      aud: CLIENT_ID,
      email,
      email_verified: true,
      // 2100-01-01: far enough ahead that the token is never expired.
      exp: 4_102_444_800,
      iss: "https://accounts.google.com",
      name: "Token exchange reader",
      sub: `token-exchange-${Bun.randomUUIDv7()}`,
    }),
    "fixture-signature",
  ].join(".");
};

/**
 * Starts a Google sign-in, then answers its callback while Google's token
 * endpoint gives the listed answers in turn. Returns the callback's redirect
 * and how many exchanges reached the token endpoint.
 */
const signInThroughExchange = async (
  answers: readonly (() => Response)[],
): Promise<{ location: URL; exchanges: number }> => {
  testState.patchConfig({
    GOOGLE_AUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_AUTH_CLIENT_SECRET: "token-exchange-google-secret",
  });
  const auth = createAuth();
  const started = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "google", callbackURL: "/matters" }),
    }),
  );
  expect(started.status).toBe(200);
  const { url } = v.parse(v.object({ url: v.string() }), await started.json());
  const state = new URL(url).searchParams.get("state") ?? "";
  const cookie = started.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0) ?? "")
    .join("; ");
  const remaining = [...answers];
  let exchanges = 0;
  const providerFetch = Object.assign(
    mock(async (input: string | URL | Request) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (!requestUrl.includes("oauth2.googleapis.com/token")) {
        return new Response("Unexpected provider request", { status: 500 });
      }
      exchanges += 1;
      const answer = remaining.shift();
      return answer === undefined
        ? new Response("No answer left", { status: 500 })
        : answer();
    }),
    { preconnect: globalThis.fetch.preconnect },
  );
  testFetchState.set(providerFetch);
  try {
    const callback = await auth.handler(
      new Request(
        `${origin}/api/auth/callback/google?code=fixture&state=${encodeURIComponent(state)}`,
        { headers: { cookie } },
      ),
    );
    expect(callback.status).toBe(302);
    return {
      location: new URL(callback.headers.get("location") ?? "", origin),
      exchanges,
    };
  } finally {
    testFetchState.restore();
  }
};

const providerFailure = () =>
  Response.json({ error: "internal_failure" }, { status: 500 });

describe("social token exchange", () => {
  test("a provider fault followed by an answer signs the user in", async () => {
    const email = `token-exchange-${Bun.randomUUIDv7()}@stella.dev`;
    const { location, exchanges } = await signInThroughExchange([
      providerFailure,
      () =>
        Response.json({
          access_token: "token-exchange-access",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: idToken(email),
        }),
    ]);
    expect(exchanges).toBe(2);
    expect(location.searchParams.get("error")).toBeNull();
    expect(location.pathname).toBe("/matters");
  });

  test("a provider still failing after the retry is reported as unavailable", async () => {
    const { location, exchanges } = await signInThroughExchange([
      providerFailure,
      providerFailure,
    ]);
    expect(exchanges).toBe(2);
    expect(location.searchParams.get("error")).toBe("temporarily_unavailable");
  });

  test("a refused code is reported as invalid and not retried", async () => {
    const { location, exchanges } = await signInThroughExchange([
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    ]);
    expect(exchanges).toBe(1);
    expect(location.searchParams.get("error")).toBe("invalid_code");
  });
});
