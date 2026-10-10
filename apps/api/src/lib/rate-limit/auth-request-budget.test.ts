import { describe, expect, test } from "bun:test";

import {
  AUTH_ACCOUNT_REQUEST_BUDGET_RULES,
  isAuthRequestBudgetPath,
  AUTH_REQUEST_BUDGET_RULES,
  AUTH_REQUEST_IP_RULE_OVERRIDES,
  resolveAuthRequestBudgetIdentity,
} from "@/api/lib/rate-limit/auth-request-budget";

const identity = (
  options: Partial<Parameters<typeof resolveAuthRequestBudgetIdentity>[0]> = {},
) =>
  resolveAuthRequestBudgetIdentity({
    path: "/oauth2/authorize",
    address: "198.51.100.10",
    body: undefined,
    readUserId: async () => undefined,
    readGrant: async () => undefined,
    ...options,
  });

describe("Auth request identities", () => {
  test.each(Object.keys(AUTH_REQUEST_BUDGET_RULES))(
    "replaces the built-in address quota for %s",
    (path) => {
      expect(isAuthRequestBudgetPath(path)).toBe(true);
      expect(AUTH_REQUEST_IP_RULE_OVERRIDES[path]).toBe(false);
    },
  );

  test("does not select unrelated or inherited properties", () => {
    for (const path of [
      "/sign-up/email",
      "toString",
      "__proto__",
      "/oauth2/token/extra",
    ]) {
      expect(isAuthRequestBudgetPath(path)).toBe(false);
    }
  });

  test.each(["/oauth2/authorize", "/oauth2/register"])(
    "isolates verified users on %s regardless of their address",
    async (path) => {
      const first = await identity({
        path,
        readUserId: async () => "first-user",
      });
      expect(first.type).toBe("verified");
      expect(
        await identity({
          path,
          address: "203.0.113.10",
          readUserId: async () => "first-user",
        }),
      ).toEqual(first);
      expect(
        await identity({ path, readUserId: async () => "second-user" }),
      ).not.toEqual(first);
    },
  );

  test.each(Object.keys(AUTH_ACCOUNT_REQUEST_BUDGET_RULES))(
    "groups %s by normalized account independently of address and cookies",
    async (path) => {
      const first = await identity({
        path,
        body: { email: "Person@Example.test" },
      });
      expect(first.type).toBe("account");
      expect(
        await identity({
          path,
          address: "203.0.113.10",
          body: { email: " person@example.test " },
          readUserId: async () => "cookie-user",
        }),
      ).toEqual(first);
      expect(
        await identity({ path, body: { email: "second@example.test" } }),
      ).not.toEqual(first);
      expect(first.key).not.toContain("person");
      for (const body of [undefined, {}, { email: 42 }, { email: " " }]) {
        expect((await identity({ path, body })).type).toBe("anonymous");
      }
    },
  );

  test("keeps the user-client quota stable across code exchange and every refresh", async () => {
    const readGrant = async () => ({
      userId: "first-user",
      clientId: "client-a",
    });
    const first = await identity({
      path: "/oauth2/token",
      body: { grant_type: "authorization_code", code: "code-a" },
      readGrant,
    });
    expect(first.type).toBe("verified");
    for (const token of ["refresh-a", "refresh-b", "refresh-c"]) {
      expect(
        await identity({
          path: "/oauth2/token",
          address: "203.0.113.10",
          body: {
            grant_type: "refresh_token",
            refresh_token: token,
            client_id: "client-a",
          },
          readGrant,
        }),
      ).toEqual(first);
    }
    for (const grant of [
      { userId: "first-user", clientId: "client-b" },
      { userId: "second-user", clientId: "client-a" },
    ]) {
      expect(
        await identity({
          path: "/oauth2/token",
          body: { grant_type: "refresh_token", refresh_token: "other" },
          readGrant: async () => grant,
        }),
      ).not.toEqual(first);
    }
  });

  test("unproved token identities and mismatched clients retain an address quota", async () => {
    const anonymous = await identity({ path: "/oauth2/token" });
    for (const body of [
      undefined,
      {},
      { grant_type: "client_credentials", client_id: "declared" },
      { grant_type: "refresh_token", refresh_token: "" },
      { grant_type: "refresh_token", refresh_token: "unknown" },
    ]) {
      expect(
        await identity({
          path: "/oauth2/token",
          body,
          readUserId: async () => "cookie-user",
        }),
      ).toEqual(anonymous);
    }
    expect(
      await identity({
        path: "/oauth2/token",
        body: {
          grant_type: "refresh_token",
          refresh_token: "known",
          client_id: "other",
        },
        readGrant: async () => ({ userId: "user", clientId: "actual" }),
      }),
    ).toEqual(anonymous);
  });

  test("anonymous registration groups a callback set independently of ordering, labels and address", async () => {
    const redirects = [
      "https://first.example/callback",
      "https://second.example/callback",
    ];
    const first = await identity({
      path: "/oauth2/register",
      body: { redirect_uris: redirects },
    });
    expect(first.type).toBe("registration");
    expect(
      await identity({
        path: "/oauth2/register",
        address: "203.0.113.10",
        body: {
          redirect_uris: [...redirects.toReversed(), redirects[0]],
          client_name: "Changed",
        },
      }),
    ).toEqual(first);
    expect(
      await identity({
        path: "/oauth2/register",
        body: { redirect_uris: ["https://third.example/callback"] },
      }),
    ).not.toEqual(first);
    for (const body of [
      undefined,
      {},
      { redirect_uris: [] },
      { redirect_uris: ["invalid"] },
      { redirect_uris: [42] },
    ]) {
      expect((await identity({ path: "/oauth2/register", body })).type).toBe(
        "anonymous",
      );
    }
  });
});
