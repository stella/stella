import { env } from "@/api/env";
import { routes } from "@/api/http/route";
import {
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth/auth-paths";
import { defineEndpoint } from "@/api/lib/endpoints";
import { bridgeOauthUiRedirect } from "@/api/lib/oauth-ui-fragment";

export {
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth/auth-paths";

const OAUTH_SIGNATURE_PARAM = "sig";

/** The OAuth UI pages live on the frontend; the API forwards to them. */
const redirectToFrontend = (path: string) =>
  defineEndpoint.public({}, ({ request }) => {
    const url = new URL(request.url);
    const redirectUrl = new URL(
      path,
      `${env.FRONTEND_URL.replace(/\/$/u, "")}/`,
    );

    if (url.searchParams.has(OAUTH_SIGNATURE_PARAM)) {
      const bridged = bridgeOauthUiRedirect({
        authOrigin: url.origin,
        frontendUrl: env.FRONTEND_URL,
        location: url.toString(),
      });
      if (bridged) {
        return Response.redirect(bridged, 302);
      }
    } else {
      redirectUrl.search = url.search;
    }

    return Response.redirect(redirectUrl.toString(), 302);
  });

export const authUiRoute = routes({
  [OAUTH_UI_LOGIN_PATH]: { GET: redirectToFrontend("/auth") },
  [OAUTH_UI_ORGANIZATION_PATH]: {
    GET: redirectToFrontend("/auth/organization"),
  },
  [OAUTH_UI_CONSENT_PATH]: { GET: redirectToFrontend("/consent") },
});
