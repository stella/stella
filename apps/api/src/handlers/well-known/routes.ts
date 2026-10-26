/**
 * Public well-known endpoints served from the API host. OAuth metadata
 * well-knowns are mounted by the auth stack; this file carries the remaining
 * static ones.
 *
 * `/.well-known/openai-apps-challenge` serves a plain-text host-control token
 * when `OPENAI_APPS_CHALLENGE_TOKEN` is configured and 404s otherwise, so
 * instances that never set the token expose nothing.
 */

import { env } from "@/api/env";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { defineEndpoint } from "@/api/lib/endpoints";

const openAiAppsChallenge = defineEndpoint.public({}, () => {
  const token = env.OPENAI_APPS_CHALLENGE_TOKEN;
  if (!token) {
    return status(404);
  }
  return new Response(token, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
});

export const wellKnownRoute = routes({
  "/.well-known/openai-apps-challenge": { GET: openAiAppsChallenge },
});
