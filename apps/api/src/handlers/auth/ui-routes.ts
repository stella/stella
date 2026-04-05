import Elysia from "elysia";

import { env } from "@/api/env";

const redirectToFrontend = ({
  path,
  request,
}: {
  path: string;
  request: Request;
}) => {
  const url = new URL(request.url);
  const redirectUrl = new URL(path, `${env.FRONTEND_URL.replace(/\/$/, "")}/`);
  redirectUrl.search = url.search;

  return Response.redirect(redirectUrl.toString(), 302);
};

export const authUiRoute = new Elysia()
  .get("/auth", ({ request }) => redirectToFrontend({ path: "/auth", request }))
  .get("/auth/organization", ({ request }) =>
    redirectToFrontend({ path: "/auth/organization", request }),
  )
  .get("/consent", ({ request }) =>
    redirectToFrontend({ path: "/consent", request }),
  );
