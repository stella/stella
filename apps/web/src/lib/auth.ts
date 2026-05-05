import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { ac, roles } from "@stll/permissions";
import { stellaToast } from "@stll/ui/components/toast";
import type { BetterAuthClientPlugin } from "better-auth/client";
import {
  emailOTPClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { env } from "@/env";
import { getTranslator, useI18nStore } from "@/i18n/i18n-store";
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

export type Role = keyof typeof roles;
export type AuthErrorCode = keyof typeof authClient.$ERROR_CODES;
