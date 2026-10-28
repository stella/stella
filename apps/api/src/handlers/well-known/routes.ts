/**
 * Public host-level endpoints served from the API host. OAuth metadata
 * well-knowns are mounted by the auth stack; this file carries the remaining
 * static ones.
 *
 * `/.well-known/openai-apps-challenge` serves a plain-text host-control token
 * when `OPENAI_APPS_CHALLENGE_TOKEN` is configured and 404s otherwise, so
 * instances that never set the token expose nothing.
 *
 * `/favicon.ico` serves the stella icon itself, so clients that show "the
 * favicon of the server's URL" for the API or its MCP endpoint find an image
 * on this host without following a cross-origin redirect.
 */

// The canonical stella logo: the bytes the web app publishes at
// `MCP_LOGO_PATH`, embedded into the API bundle as an asset.
import stellaIconPath from "@stll/api-contract/stella-logo-512.png" with { type: "file" };

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

const favicon = defineEndpoint.public(
  { cache: { kind: "public", maxAge: 86_400, swr: 604_800 } },
  () =>
    new Response(Bun.file(stellaIconPath), {
      headers: {
        "content-type": "image/png",
        "x-content-type-options": "nosniff",
      },
    }),
);

export const wellKnownRoute = routes({
  "/.well-known/openai-apps-challenge": { GET: openAiAppsChallenge },
  "/favicon.ico": { GET: favicon },
});
