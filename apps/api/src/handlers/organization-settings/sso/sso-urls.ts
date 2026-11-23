import { env } from "@/api/env";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";

export const ssoProviderUrls = {
  callbackUrlFor: (providerId: string): string =>
    getAuthEndpointUrl(`sso/callback/${encodeURIComponent(providerId)}`),
  launchUrlFor: (providerId: string): string => {
    const appOrigin = (env.PUBLIC_URL ?? env.FRONTEND_URL).replace(/\/+$/u, "");
    return `${appOrigin}/auth?sso=${encodeURIComponent(providerId)}`;
  },
} as const;
