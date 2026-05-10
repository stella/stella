import { Result } from "better-result";
import Elysia from "elysia";

import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { createProbeCache } from "@/api/lib/health/probe-cache";
import type { ProbeOutcome } from "@/api/lib/health/probe-cache";
import { probeDatabase } from "@/api/lib/health/probe-database";

const APP_VERSION = process.env["STELLA_VERSION"] ?? "dev";
const APP_COMMIT_SHA = process.env["STELLA_COMMIT_SHA"] ?? "dev";
const BUILD_METADATA = {
  version: APP_VERSION,
  commit: APP_COMMIT_SHA,
};

const PROBE_TIMEOUT_MS = 5000;

// Coalesces concurrent /health calls onto a single in-flight probe and
// reuses the outcome for this window, so liveness checks (k8s, ALB) and
// any drive-by traffic don't translate one-to-one into DB round-trips.
const PROBE_CACHE_TTL_MS = 5000;

const unrefTimer = (timerId: ReturnType<typeof setTimeout>) => {
  if (
    typeof timerId === "object" &&
    timerId !== null &&
    "unref" in timerId &&
    typeof timerId.unref === "function"
  ) {
    timerId.unref();
  }
};

const runDatabaseProbe = async (): Promise<ProbeOutcome<HealthCheckError>> => {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timerId = setTimeout(
      () => reject(new HealthCheckError({ message: "DB probe timeout" })),
      PROBE_TIMEOUT_MS,
    );
    // `unref` keeps a still-pending timeout from holding the event
    // loop open at shutdown if the race resolves before we reach the
    // clearTimeout below.
    unrefTimer(timerId);
  });
  const result = await Result.tryPromise(async () => {
    try {
      return await Promise.race([probeDatabase(), timeout]);
    } finally {
      clearTimeout(timerId);
    }
  });
  if (result.isErr()) {
    const cause = result.error;
    return {
      ok: false,
      error: HealthCheckError.is(cause)
        ? cause
        : new HealthCheckError({ message: "DB probe failed", cause }),
    };
  }
  return { ok: true };
};

const probeCache = createProbeCache(runDatabaseProbe, {
  ttlMs: PROBE_CACHE_TTL_MS,
});

export const healthRoute = new Elysia().get("/health", async ({ set }) => {
  const outcome = await probeCache.run();

  if (!outcome.ok) {
    set.status = 503;
    return {
      status: "error" as const,
      message: "Database unreachable",
      ...BUILD_METADATA,
    };
  }

  return { status: "ok" as const, ...BUILD_METADATA };
});
