import { env } from "@/api/env";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";

export const ssoProviderUrls = {
  callbackUrlFor: (providerId: string): string =>
    getAuthEndpointUrl(`sso/callback/${encodeURIComponent(providerId)}`),
  acsUrlFor: (providerId: string): string =>
    getAuthEndpointUrl(`sso/saml2/sp/acs/${encodeURIComponent(providerId)}`),
  spMetadataUrlFor: (providerId: string): string =>
    getAuthEndpointUrl(
      `sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`,
    ),
  launchUrlFor: (providerId: string): string => {
    let appOrigin = env.PUBLIC_URL ?? env.FRONTEND_URL;
    while (appOrigin.endsWith("/")) {
      appOrigin = appOrigin.slice(0, -1);
    }
    return `${appOrigin}/auth?sso=${encodeURIComponent(providerId)}`;
  },
} as const;
