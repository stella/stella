import { AUTH_SOCIAL_PROVIDER_IDS } from "@stll/auth-model";

import { env } from "@/env";

export const socialProviderFlags = {
  google: env.VITE_AUTH_GOOGLE,
  microsoft: env.VITE_AUTH_MICROSOFT,
  apple: env.VITE_AUTH_APPLE,
};

export const configuredSocialProviders = AUTH_SOCIAL_PROVIDER_IDS.filter(
  (provider) => socialProviderFlags[provider],
);
