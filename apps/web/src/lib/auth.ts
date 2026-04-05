import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type {
  BetterAuthClientOptions,
  BetterAuthClientPlugin,
} from "better-auth/client";
import {
  emailOTPClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { ac, roles } from "@stella/permissions";
import { toastManager } from "@stella/ui/components/toast";

import { env } from "@/env";
import { getTranslator, useI18nStore } from "@/i18n/i18n-store";

export const HTTP_TOO_MANY_REQUESTS = 429;

const authClientPlugins = [
  emailOTPClient(),
  lastLoginMethodClient(),
  organizationClient({ ac, roles }),
  inferAdditionalFields({
    user: {
      timezoneId: { type: "string" },
    },
  }),
  // SAFETY: the OAuth provider client is a valid Better Auth client plugin
  // at runtime. This narrow cast keeps the oauth2 endpoints available while
  // working around upstream metadata typing friction.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  oauthProviderClient() as BetterAuthClientPlugin &
    ReturnType<typeof oauthProviderClient>,
];

type StellaAuthClientOptions = BetterAuthClientOptions & {
  plugins: typeof authClientPlugins;
};

export const authClient = createAuthClient<StellaAuthClientOptions>({
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
        toastManager.add({
          title: t("auth.rateLimitExceeded"),
          type: "error",
        });
      }
    },
  },
});

export type Role = keyof typeof roles;
export type AuthErrorCode = keyof typeof authClient.$ERROR_CODES;
