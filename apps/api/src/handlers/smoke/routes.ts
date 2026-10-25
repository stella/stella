/**
 * Synthetic-monitoring session endpoint.
 *
 * Lets the post-deploy verification job (deploy-staging.yml,
 * `verify-staging`) authenticate as a dedicated smoke user without
 * an email round-trip, so a headless browser can exercise real
 * authenticated routes right after a deploy.
 *
 * Security model:
 *  - The route exists only when SMOKE_SESSION_SECRET is configured.
 *    That presence check is the environment gate: infrastructure
 *    injects the secret on non-production deployments only, and
 *    production must never configure it. A NODE_ENV guard would be
 *    meaningless here — the deployed binary is compiled with
 *    NODE_ENV=production and Bun inlines that read at build time,
 *    so it cannot distinguish staging from production at runtime.
 *  - The caller must present the secret in `x-smoke-secret`;
 *    comparison is constant-time over digests so neither length
 *    nor prefix leaks. Failures return the same 404 as "disabled"
 *    to keep the surface indistinguishable from a missing route.
 *  - Sessions are short-lived (15 min) and scoped to a dedicated
 *    smoke user/org that mirrors the production default state
 *    (no entitlement, no AI config). `?principal=ai` selects a second
 *    dedicated org whose AI the caller configures through the regular
 *    organization settings API.
 */

import { timingSafeEqual } from "node:crypto";

import { sha256Bytes as hashSha256Bytes } from "@stll/sha256/bun";

import { env } from "@/api/env";
import { routes } from "@/api/http/route";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { defineEndpoint } from "@/api/lib/endpoints";
import { logger } from "@/api/lib/observability/logger";
import {
  bringReleaseLoadJobsForward,
  readReleaseLoadJobs,
} from "@/api/lib/scheduler/release-load-jobs";
import {
  mintSmokeSession,
  parseSmokePrincipal,
} from "@/api/lib/smoke-session/store";

const notAvailable = () => new Response("Not available", { status: 404 });

const isAuthorizedSmokeCaller = (headerSecret: string | null): boolean => {
  const configured = env.SMOKE_SESSION_SECRET;
  if (!configured || !headerSecret) {
    return false;
  }
  const a = hashSha256Bytes(configured);
  const b = hashSha256Bytes(headerSecret);
  return timingSafeEqual(a, b);
};

// No body is read: the secret travels in a header and the principal in the query.
const mintSession = defineEndpoint.public(
  { bodyMode: "none" },
  async ({ request }) => {
    if (!isAuthorizedSmokeCaller(request.headers.get("x-smoke-secret"))) {
      return notAvailable();
    }

    // Parsed only after the secret check, so an unauthenticated caller
    // cannot tell a bad parameter from a missing route.
    const principal = parseSmokePrincipal(
      new URL(request.url).searchParams.get("principal"),
    );
    if (principal === null) {
      return new Response("Unknown smoke principal", { status: 400 });
    }

    const smokeSession = await mintSmokeSession(principal);
    logger.info("smoke.session_minted", {
      "smoke.principal": principal,
      "smoke.expires_at": smokeSession.expiresAt,
    });
    return smokeSession;
  },
);

/**
 * The scheduled corpus jobs the release proof's MCP load overlaps. Same gate
 * as the session route: inert unless the smoke secret is configured, which
 * production never is. A caller holding the secret can only move the listed
 * recurring jobs' next run forward, never pause, edit or add a job.
 */
const readScheduledLoadJobs = defineEndpoint.public(
  { bodyMode: "none" },
  async ({ request }) => {
    if (!isAuthorizedSmokeCaller(request.headers.get("x-smoke-secret"))) {
      return notAvailable();
    }
    return { jobs: await readReleaseLoadJobs() };
  },
);

const bringScheduledLoadJobsForward = defineEndpoint.public(
  { bodyMode: "none" },
  async ({ request }) => {
    if (!isAuthorizedSmokeCaller(request.headers.get("x-smoke-secret"))) {
      return notAvailable();
    }
    const dueAt = new Date();
    const jobs = await bringReleaseLoadJobsForward();
    logger.info("smoke.scheduled_jobs_brought_forward", {
      "smoke.job_ids": jobs.map(({ id }) => id).join(","),
    });
    return { dueAt, jobs };
  },
);

declareAggregateMutation(bringScheduledLoadJobsForward, {
  type: "independent",
  reason:
    "Moves the next run of fixed recurring corpus jobs to now on a non-production deployment. The scheduler's lease claim arbitrates with every replica, so the update shares no aggregate with a request.",
});

export const smokeRoute = routes(
  {
    "/session": { POST: mintSession },
    "/scheduled-jobs": {
      GET: readScheduledLoadJobs,
      POST: bringScheduledLoadJobsForward,
    },
  },
  { prefix: "/smoke" },
);
