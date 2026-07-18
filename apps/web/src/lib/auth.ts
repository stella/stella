import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { BetterAuthClientPlugin } from "better-auth/client";
import {
  emailOTPClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { Result } from "better-result";

import { ac, roles } from "@stll/permissions";
import { stellaToast } from "@stll/ui/components/toast";

import { env } from "@/env";
import { getTranslator, useI18nStore } from "@/i18n/i18n-store";
import { getSignedOauthQueryFromHash } from "@/lib/oauth-provider";
import { createSecretTokenBoundary } from "@/lib/secret-token";
import type { SecretToken } from "@/lib/secret-token";

export const HTTP_TOO_MANY_REQUESTS = 429;
const SESSION_REVOCATION_TOKEN = "better-auth-session-revocation";
const sessionRevocationTokenBoundary = createSecretTokenBoundary(
  SESSION_REVOCATION_TOKEN,
);

const defineBetterAuthClientPlugin = <TPlugin extends BetterAuthClientPlugin>(
  plugin: TPlugin,
): TPlugin => plugin;

const withOauthQueryFromHash = (ctx: {
  body?: unknown;
  headers: Headers;
  method: string;
}) => {
  if (
    typeof window === "undefined" ||
    ctx.method === "GET" ||
    ctx.method === "DELETE"
  ) {
    return;
  }

  const oauthQuery = getSignedOauthQueryFromHash(window.location.hash);
  if (!oauthQuery) {
    return;
  }

  const contentType = ctx.headers.get("content-type");
  const rawBody = ctx.body;
  let body = rawBody;
  if (
    typeof rawBody === "string" &&
    contentType?.toLowerCase().startsWith("application/json")
  ) {
    const parsed = Result.try((): unknown => JSON.parse(rawBody));
    if (Result.isError(parsed)) {
      return;
    }
    body = parsed.value;
  }

  if (typeof body !== "object" || body === null || "oauth_query" in body) {
    return;
  }

  ctx.headers.set("content-type", "application/json");
  ctx.body = JSON.stringify({ ...body, oauth_query: oauthQuery });
};

export type SessionRevocationToken = SecretToken<
  typeof SESSION_REVOCATION_TOKEN
>;

const createSessionRevocationToken = (value: string): SessionRevocationToken =>
  sessionRevocationTokenBoundary.create(value);

const revealSessionRevocationToken = (token: SessionRevocationToken): string =>
  sessionRevocationTokenBoundary.reveal(token);

const authClientPlugins = [
  emailOTPClient(),
  lastLoginMethodClient(),
  organizationClient({ ac, roles }),
  inferAdditionalFields({
    user: {
      preferredName: { type: "string", required: false },
      timezoneId: { type: "string" },
      wordEditShortcut: { type: "string", required: false },
    },
  }),
  defineBetterAuthClientPlugin(oauthProviderClient()),
  // No `onTwoFactorRedirect`/`twoFactorPage`: those globally intercept every
  // sign-in call, which would lose the in-flight `redirectTo` search param.
  // The email-OTP sign-in step (otp-panel.tsx) reads `twoFactorRedirect` off
  // its own response instead and navigates to `/auth/two-factor` explicitly.
  twoFactorClient(),
];

export const authClient = createAuthClient({
  baseURL: env.VITE_API_URL,
  plugins: authClientPlugins,
  fetchOptions: {
    headers: {
      get "Accept-Language"() {
        return useI18nStore.getState().lang;
      },
    },
    onRequest: withOauthQueryFromHash,
    onError: (context) => {
      if (context.response.status === HTTP_TOO_MANY_REQUESTS) {
        const t = getTranslator();
        stellaToast.add({
          title: t("auth.rateLimitExceeded"),
          type: "error",
        });
      }
    },
  },
});

export const listAuthSessions = async () => {
  const result = await authClient.listSessions();

  if (result.error) {
    return result;
  }

  return {
    data: result.data.map((session) => ({
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      id: session.id,
      ipAddress: session.ipAddress,
      updatedAt: session.updatedAt,
      userAgent: session.userAgent,
      token: createSessionRevocationToken(session.token),
      userId: session.userId,
    })),
    error: null,
  };
};

export const revokeAuthSession = async ({
  token,
}: {
  token: SessionRevocationToken;
}) =>
  await authClient.revokeSession({
    token: revealSessionRevocationToken(token),
  });

// The two-factor server plugin rewrites a sign-in endpoint's response body to
// `{ twoFactorRedirect: true, twoFactorMethods }` when the signed-in user has
// 2FA enabled. That rewrite happens through a server-side hook shared across
// every sign-in method, so the sign-in endpoints' own declared response types
// (e.g. `signIn.emailOtp`) never include it. Narrow structurally instead of
// casting so this keeps working whether or not a given better-auth version
// reflects the rewrite in its types.
export const isTwoFactorRedirect = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  return "twoFactorRedirect" in data && data.twoFactorRedirect === true;
};

// Structural check for `session.user.twoFactorEnabled`: the twoFactorClient
// plugin declares `$InferServerPlugin` to merge this field onto the session
// user type, but this app's authClient is not generically parameterized by
// the backend's `auth` instance (see `inferAdditionalFields` above, which
// re-declares custom fields by hand for the same reason), so whether the
// field actually flows through depends on better-auth's client typing. Narrow
// structurally so this reads correctly either way.
export const isTwoFactorEnabledUser = (user: unknown): boolean => {
  if (typeof user !== "object" || user === null) {
    return false;
  }

  return "twoFactorEnabled" in user && user.twoFactorEnabled === true;
};

export type Role = keyof typeof roles;
export type AuthErrorCode = keyof typeof authClient.$ERROR_CODES;
