import { Result } from "better-result";
import Elysia from "elysia";

import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { probeDatabase } from "@/api/lib/health/probe-database";

const APP_VERSION = process.env["STELLA_VERSION"] ?? "dev";
const APP_COMMIT_SHA = process.env["STELLA_COMMIT_SHA"] ?? "dev";
const BUILD_METADATA = {
  version: APP_VERSION,
  commit: APP_COMMIT_SHA,
};

export const healthRoute = new Elysia().get("/health", async ({ set }) => {
  const probe = probeDatabase();
  const timeout = new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(new HealthCheckError({ message: "DB probe timeout" })),
      5000,
    );
  });
  const result = await Result.tryPromise(
    async () => await Promise.race([probe, timeout]),
  );

  if (result.isErr()) {
    set.status = 503;
    return {
      status: "error" as const,
      message: "Database unreachable",
      ...BUILD_METADATA,
    };
  }

  return { status: "ok" as const, ...BUILD_METADATA };
});
