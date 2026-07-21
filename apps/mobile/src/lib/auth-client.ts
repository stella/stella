import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

import { STELLA_AUTH_COOKIE_PREFIXES } from "@stll/api-contract";

import { env } from "@/env";

export const authClient = createAuthClient({
  baseURL: env.API_URL,
  plugins: [
    expoClient({
      cookiePrefix: [...STELLA_AUTH_COOKIE_PREFIXES],
      storage: SecureStore,
      storagePrefix: "stella-auth",
    }),
  ],
});
