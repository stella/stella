import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import * as v from "valibot";

import { AUTH_SOCIAL_PROVIDER_IDS } from "@stll/auth-model";

import {
  createSocialProvider,
  createSocialProviders,
  getAuth,
} from "@/api/lib/auth";
import {
  classifyAuthSessionPath,
  isNewDeviceNoticeAuthPath,
  isSessionCreatingAuthPath,
} from "@/api/lib/auth/session-path-classification";

const BASE_URL = "http://localhost:3001";

const getEnabledAuthEndpointPaths = () => {
  const auth = getAuth();
  const disabledPaths = new Set(auth.options.disabledPaths);
  return Object.values(auth.api)
    .map((endpoint) => endpoint.path)
    .filter((path): path is string => typeof path === "string")
    .filter((path) => !disabledPaths.has(path));
};

describe("auth session paths", () => {
  test("classifies every auth endpoint", () => {
    const unclassified = getEnabledAuthEndpointPaths().filter(
      (path) => classifyAuthSessionPath(path) === undefined,
    );

    expect(unclassified).toEqual([]);
  });

  test("identifies only configured session-establishing endpoints", () => {
    const expectedSessionCreatingPaths = new Set([
      "/callback/:id",
      "/email-otp/verify-email",
      "/mcp-handoff/redeem",
      "/sign-in/email",
      "/sign-in/email-otp",
      "/sign-in/social",
      "/sign-up/email",
    ]);

    const enabledPaths = getEnabledAuthEndpointPaths();
    for (const path of enabledPaths) {
      expect(isSessionCreatingAuthPath(path), path).toBe(
        expectedSessionCreatingPaths.has(path),
      );
    }
    expect(enabledPaths.filter(isSessionCreatingAuthPath).toSorted()).toEqual(
      [...expectedSessionCreatingPaths].toSorted(),
    );
  });

  test("identifies only configured new-device notice completion endpoints", () => {
    const expectedNoticeOnlyPaths = new Set([
      "/two-factor/verify-backup-code",
      "/two-factor/verify-otp",
      "/two-factor/verify-totp",
    ]);
    const noticeOnlyPaths = getEnabledAuthEndpointPaths().filter(
      (path) =>
        isNewDeviceNoticeAuthPath(path) && !isSessionCreatingAuthPath(path),
    );

    expect(noticeOnlyPaths.toSorted()).toEqual(
      [...expectedNoticeOnlyPaths].toSorted(),
    );
  });

  test("keeps verification from signing in automatically", () => {
    expect(
      getAuth().options.emailVerification.autoSignInAfterVerification,
    ).toBe(false);
    expect(isSessionCreatingAuthPath("/verify-email")).toBe(false);
  });

  test("configures every social provider for authorization redirects", () => {
    const configured = createSocialProviders({
      googleClientId: "google-client-id",
      googleClientSecret: "google-client-secret",
      microsoftClientId: "microsoft-client-id",
      microsoftClientSecret: "microsoft-client-secret",
      microsoftTenantId: "common",
      apple: {
        type: "enabled",
        clientId: "app.example.web",
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
          .privateKey,
      },
    });

    expect(Object.keys(configured).toSorted()).toEqual(
      [...AUTH_SOCIAL_PROVIDER_IDS].toSorted(),
    );
    for (const provider of Object.values(configured)) {
      expect(provider.disableIdTokenSignIn).toBe(true);
    }
    // Apple's secret is minted on read; a copied value would expire.
    expect(
      Object.getOwnPropertyDescriptor(configured.apple, "clientSecret")?.get,
    ).toBeFunction();
  });

  test("social sign-in uses provider authorization redirects", async () => {
    const auth = betterAuth({
      baseURL: BASE_URL,
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      socialProviders: {
        google: createSocialProvider({
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
        }),
      },
    });

    const idTokenResponse = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          idToken: { token: "token" },
        }),
      }),
    );
    expect(idTokenResponse.status).toBe(404);
    expect(await idTokenResponse.json()).toMatchObject({
      code: "ID_TOKEN_NOT_SUPPORTED",
    });
    expect(idTokenResponse.headers.get("set-cookie")).toBeNull();

    const redirectResponse = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      }),
    );
    expect(redirectResponse.status).toBe(200);
    const body = v.parse(
      v.object({ redirect: v.boolean(), url: v.string() }),
      await redirectResponse.json(),
    );
    expect(body).toMatchObject({ redirect: true });
    expect(new URL(body.url).origin).toBe("https://accounts.google.com");
  });
});
