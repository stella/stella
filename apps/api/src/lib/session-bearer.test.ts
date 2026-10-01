import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { describe, expect, test } from "bun:test";

import { createSessionBearer } from "@/api/lib/session-bearer";

describe("session credentials", () => {
  test("accepts only valid session credentials", async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:3001",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      emailAndPassword: { enabled: true },
      plugins: [createSessionBearer()],
    });
    const response = await auth.api.signUpEmail({
      body: {
        email: "account@example.test",
        name: "Account",
        password: "A secure password 123!",
      },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.has("set-auth-token")).toBe(false);
    expect(
      response.headers.get("access-control-expose-headers") ?? "",
    ).not.toContain("set-auth-token");
    const cookie = response.headers
      .get("set-cookie")
      ?.match(/(?:^|,\s*)better-auth\.session_token=([^;]+)/u)
      ?.at(1);
    expect(cookie).toBeDefined();
    if (!cookie) {
      throw new Error("Session cookie is required");
    }
    const credential = decodeURIComponent(cookie);
    expect(
      await auth.api.getSession({
        headers: { authorization: `Bearer ${credential}` },
      }),
    ).not.toBeNull();
    expect(
      await auth.api.getSession({
        headers: { authorization: `Bearer ${credential.split(".").at(0)}` },
      }),
    ).toBeNull();
    expect(
      await auth.api.getSession({
        headers: { authorization: "Bearer invalid" },
      }),
    ).toBeNull();
    expect(await auth.api.getSession({ headers: {} })).toBeNull();
    const token = credential.split(".").at(0);
    if (!token) {throw new Error("Session credential is required");}
    const context = await auth.$context;
    await context.internalAdapter.updateSession(token, {
      expiresAt: new Date(0),
    });
    expect(
      await auth.api.getSession({
        headers: { authorization: `Bearer ${credential}` },
      }),
    ).toBeNull();
  });
});
