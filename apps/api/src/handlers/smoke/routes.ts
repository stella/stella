/**
 * Synthetic-monitoring session endpoint.
 *
 * Lets the post-deploy verification job (deploy-staging.yml,
 * `verify-staging`) authenticate as a dedicated smoke user without
 * an email round-trip, so a headless browser can exercise real
 * authenticated routes right after a deploy.
 *
 * Security model:
 *  - Hard-disabled on production: NODE_ENV === "production" returns
 *    404 before any other check, independent of configuration.
 *  - Disabled unless SMOKE_SESSION_SECRET is configured (staging
 *    sets it via SSM; environments without it have no such route).
 *  - The caller must present the secret in `x-smoke-secret`;
 *    comparison is constant-time over digests so neither length
 *    nor prefix leaks. Failures return the same 404 as "disabled"
 *    to keep the surface indistinguishable from a missing route.
 *  - Sessions are short-lived (15 min) and scoped to a dedicated
 *    smoke user/org that mirrors the production default state
 *    (no entitlement, no AI config).
 */

import Elysia from "elysia";
import { timingSafeEqual } from "node:crypto";

import { env } from "@/api/env";
import { logger } from "@/api/lib/observability/logger";
import { mintSmokeSession } from "@/api/lib/smoke-session/store";

const notAvailable = () => new Response("Not available", { status: 404 });

const isAuthorizedSmokeCaller = (headerSecret: string | null): boolean => {
  const configured = env.SMOKE_SESSION_SECRET;
  if (!configured || !headerSecret) {
    return false;
  }
  const a = new Bun.CryptoHasher("sha256").update(configured).digest();
  const b = new Bun.CryptoHasher("sha256").update(headerSecret).digest();
  return timingSafeEqual(a, b);
};

export const smokeRoute = new Elysia({ prefix: "/smoke" }).post(
  "/session",
  async ({ request }) => {
    if (process.env.NODE_ENV === "production") {
      return notAvailable();
    }
    if (!isAuthorizedSmokeCaller(request.headers.get("x-smoke-secret"))) {
      return notAvailable();
    }

    const smokeSession = await mintSmokeSession();
    logger.info("smoke.session_minted", {
      "smoke.expires_at": smokeSession.expiresAt,
    });
    return smokeSession;
  },
);
