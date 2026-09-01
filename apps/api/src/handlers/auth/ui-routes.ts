import Elysia from "elysia";

import { env } from "@/api/env";
import {
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth-paths";
import { bridgeOauthUiRedirect } from "@/api/lib/oauth-ui-fragment";

export {
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth-paths";

const OAUTH_SIGNATURE_PARAM = "sig";
const redirectToFrontend = ({
  path,
  request,
}: {
  path: string;
  request: Request;
}) => {
  const url = new URL(request.url);
  const redirectUrl = new URL(path, `${env.FRONTEND_URL.replace(/\/$/u, "")}/`);

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
};

export const authUiRoute = new Elysia()
  .get(OAUTH_UI_LOGIN_PATH, ({ request }) =>
    redirectToFrontend({ path: "/auth", request }),
  )
  .get(OAUTH_UI_ORGANIZATION_PATH, ({ request }) =>
    redirectToFrontend({ path: "/auth/organization", request }),
  )
  .get(OAUTH_UI_CONSENT_PATH, ({ request }) =>
    redirectToFrontend({ path: "/consent", request }),
  );
