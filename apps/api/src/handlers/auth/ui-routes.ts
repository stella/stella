import Elysia from "elysia";

import { env } from "@/api/env";

const OAUTH_SIGNATURE_PARAM = "sig";
const OAUTH_QUERY_HASH_PARAM = "oauth_query";

export const OAUTH_UI_LOGIN_PATH = "/oauth-ui/auth";
export const OAUTH_UI_ORGANIZATION_PATH = "/oauth-ui/auth/organization";
export const OAUTH_UI_CONSENT_PATH = "/oauth-ui/consent";

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
    const fragment = new URLSearchParams();
    fragment.set(OAUTH_QUERY_HASH_PARAM, url.search.slice(1));
    redirectUrl.hash = fragment.toString();
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
