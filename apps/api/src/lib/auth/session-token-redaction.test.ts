import { betterAuth } from "better-auth";
import type { BetterAuthPlugin, Session } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createSessionLifetime } from "@/api/lib/auth/session-lifetime";
import type { SessionLifetimeStore } from "@/api/lib/auth/session-lifetime";
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
  const otherToken = /session_token=([^.;]+)/u.exec(signedCookie(second))?.[1];
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
      createAuth([createSessionTokenRedactionPlugin(createAuthMiddleware)]),
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

describe("signing out another device by id", () => {
  test("a listed device is revoked by its id and its credential stops working", async () => {
    const database: {
      user: never[];
      session: Session[];
      account: never[];
      verification: never[];
    } = { user: [], session: [], account: [], verification: [] };
    const store = {
      observe: async ({ token }) =>
        database.session.find((row) => row.token === token) ?? null,
      refresh: async ({ token }) =>
        database.session.find((row) => row.token === token) ?? null,
      revokeById: async ({ sessionId, userId }) => {
        database.session = database.session.filter(
          (row) => row.id !== sessionId || row.userId !== userId,
        );
      },
    } satisfies SessionLifetimeStore;
    const lifetime = createSessionLifetime({ store });
    const auth = betterAuth({
      baseURL: "http://localhost:3001",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true },
      plugins: [
        lifetime.plugin,
        createSessionTokenRedactionPlugin(createAuthMiddleware),
      ],
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          lifetime.prepare(ctx.context);
          await Promise.resolve();
        }),
      },
    });
    const credentials = {
      email: "revoke@example.test",
      password: "Fixture password 123!",
    };
    await auth.api.signUpEmail({ body: { ...credentials, name: "Revoke" } });
    const signIn = async () =>
      signedCookie(
        await auth.api.signInEmail({ body: credentials, asResponse: true }),
      );
    const current = await signIn();
    const other = await signIn();
    const whoAmI = async (cookie: string) => {
      const response = await auth.handler(
        new Request("http://localhost:3001/api/auth/get-session", {
          headers: { cookie },
        }),
      );
      const body: unknown = await response.json();
      return body;
    };
    const otherSession = await whoAmI(other);
    const otherId =
      typeof otherSession === "object" &&
      otherSession !== null &&
      "session" in otherSession &&
      typeof otherSession.session === "object" &&
      otherSession.session !== null &&
      "id" in otherSession.session &&
      typeof otherSession.session.id === "string"
        ? otherSession.session.id
        : undefined;
    expect(otherId).toBeDefined();

    const listed = await auth.handler(
      new Request("http://localhost:3001/api/auth/list-sessions", {
        headers: { cookie: current },
      }),
    );
    const listedText = await listed.text();
    expect(listedText).toContain(otherId ?? "missing");

    const revoked = await auth.handler(
      new Request("http://localhost:3001/api/auth/revoke-session-by-id", {
        method: "POST",
        headers: {
          cookie: current,
          "content-type": "application/json",
          origin: "http://localhost:3001",
        },
        body: JSON.stringify({ sessionId: otherId }),
      }),
    );
    expect(revoked.status).toBe(200);
    expect(await whoAmI(other)).toBeNull();
    expect(await whoAmI(current)).not.toBeNull();
  });
});

const apiRoot = path.resolve(import.meta.dir, "../../..");
// Only these modules read the session table outside Better Auth: the lifetime
// store (credential checks), the new-device notice (address and user agent),
// the MCP web handoff (id and client name), the monitoring session authority
// (id and expiry only) and the event-stream liveness sweep (id and owner only).
const SESSION_TABLE_READERS = new Set([
  "src/lib/auth/mcp-web-handoff.ts",
  "src/lib/auth/session-history.ts",
  "src/lib/auth/session-lifetime-store.ts",
  "src/lib/auth/sse-session-liveness.ts",
  "src/lib/synthetic-principal/session-authority.ts",
]);
const SESSION_TABLE_READ =
  /\bquery\.session\.find|\.from\(\s*session\s*\)|\bselect\([^)]*\bsession\.token\b/u;

describe("session table census", () => {
  test("no other module reads session rows that a response could carry", () => {
    const readers = [
      ...new Glob("src/**/*.ts").scanSync({ cwd: apiRoot }),
    ].filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.includes("/tests/") &&
        SESSION_TABLE_READ.test(
          readFileSync(path.join(apiRoot, file), "utf-8"),
        ),
    );
    expect(readers.filter((file) => !SESSION_TABLE_READERS.has(file))).toEqual(
      [],
    );
    expect(
      readFileSync(
        path.join(apiRoot, "src/lib/auth/session-history.ts"),
        "utf-8",
      ),
    ).not.toMatch(/token:\s*true/u);
  });
});
