import { expoClient } from "@better-auth/expo/client";
import {
  emailOTPClient,
  lastLoginMethodClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

import {
  STELLA_AUTH_COOKIE_PREFIXES,
  STELLA_MOBILE_SCHEME,
} from "@stll/api-contract";

import { env } from "@/env";

export const authClient = createAuthClient({
  baseURL: env.API_URL,
  fetchOptions: { timeout: 8000 },
  plugins: [
    expoClient({
      cookiePrefix: [...STELLA_AUTH_COOKIE_PREFIXES],
      scheme: STELLA_MOBILE_SCHEME,
      storage: SecureStore,
      storagePrefix: "stella-auth",
    }),
    emailOTPClient(),
    lastLoginMethodClient(),
    organizationClient(),
    twoFactorClient(),
  ],
});
