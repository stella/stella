/**
 * Public well-known endpoints served from the API host. OAuth metadata
 * well-knowns are mounted by the auth stack; this file carries the remaining
 * static ones.
 *
 * `/.well-known/openai-apps-challenge` serves a plain-text host-control token
 * when `OPENAI_APPS_CHALLENGE_TOKEN` is configured and 404s otherwise, so
 * instances that never set the token expose nothing.
 */

import Elysia, { status } from "elysia";

import { env } from "@/api/env";

export const wellKnownRoute = new Elysia().get(
  "/.well-known/openai-apps-challenge",
  () => {
    const token = env.OPENAI_APPS_CHALLENGE_TOKEN;
    if (!token) {
      return status(404);
    }
    return new Response(token, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
);
