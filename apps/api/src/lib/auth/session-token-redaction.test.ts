import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, test } from "bun:test";

import {
  createSessionTokenRedactionPlugin,
  redactForeignSessionTokens,
} from "@/api/lib/auth/session-token-redaction";

const session = (id: string, token: string) => ({
  id,
  token,
  userId: "user_1",
  expiresAt: new Date("2026-11-01T00:00:00.000Z"),
});

describe("redactForeignSessionTokens", () => {
  test("keeps only the caller's own session token", () => {
    const { value, changed } = redactForeignSessionTokens(
      [session("own", "own-token"), session("other", "other-token")],
      new Set(["own-token"]),
    );
    expect(changed).toBe(true);
    expect(value).toEqual([
      session("own", "own-token"),
      {
        id: "other",
        userId: "user_1",
        expiresAt: new Date("2026-11-01T00:00:00.000Z"),
      },
    ]);
  });

  test("redacts session rows nested in any response shape", () => {
    const { value } = redactForeignSessionTokens(
      { data: { sessions: [session("other", "other-token")] } },
      new Set(),
    );
    expect(JSON.stringify(value)).not.toContain("other-token");
  });

  test("leaves non-session tokens and unchanged values untouched", () => {
    const signIn = { redirect: false, token: "own-new-token", user: {} };
    const oauth = { access_token: "a", token_type: "Bearer" };
    for (const value of [signIn, oauth, null, "text", 1]) {
      const redacted = redactForeignSessionTokens(value, new Set());
      expect(redacted.changed).toBe(false);
      expect(redacted.value).toBe(value);
    }
  });
});

const createAuth = (plugins: BetterAuthPlugin[]) =>
  betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins,
  });

const signedCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");

const twoDeviceSessions = async (auth: ReturnType<typeof createAuth>) => {
  const credentials = {
    email: "devices@example.test",
    password: "Fixture password 123!",
  };
  await auth.api.signUpEmail({
    body: { ...credentials, name: "Devices" },
  });
  const signIn = async () =>
    await auth.api.signInEmail({ body: credentials, asResponse: true });
  const first = await signIn();
  const second = await signIn();
  const listed = await auth.handler(
    new Request("http://localhost:3001/api/auth/list-sessions", {
      headers: { cookie: signedCookie(first) },
    }),
  );
  const otherToken = signedCookie(second).match(/session_token=([^.;]+)/u)?.[1];
  return { listed, otherToken };
};

describe("session list over HTTP", () => {
  test("without redaction the session list carries other devices' tokens", async () => {
    const { listed, otherToken } = await twoDeviceSessions(createAuth([]));
    expect(otherToken).toBeDefined();
    expect(await listed.text()).toContain(otherToken ?? "");
  });

  test("the session list shows other devices by id only", async () => {
    const { listed, otherToken } = await twoDeviceSessions(
      createAuth([createSessionTokenRedactionPlugin()]),
    );
    expect(listed.status).toBe(200);
    const body: unknown = await listed.json();
    expect(Array.isArray(body) ? body.length : 0).toBe(3);
    expect(JSON.stringify(body)).not.toContain(otherToken ?? "missing");
    const ids = Array.isArray(body)
      ? body.map((row: { id?: unknown }) => typeof row.id)
      : [];
    expect(ids).toEqual(["string", "string", "string"]);
  });
});
