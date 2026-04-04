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

export const authClient = createAuthClient({
  baseURL: env.VITE_API_URL,
  plugins: [
    emailOTPClient(),
    lastLoginMethodClient(),
    organizationClient({ ac, roles }),
    inferAdditionalFields({
      user: {
        timezoneId: { type: "string" },
      },
    }),
  ],
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
