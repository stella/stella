import Elysia from "elysia";

import prepareDocumentTranslation from "@/api/handlers/document-translations/prepare";
import createDocumentTranslationRun from "@/api/handlers/document-translations/runs/create";
import readDocumentTranslationRun from "@/api/handlers/document-translations/runs/get";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import { isTranslateRateLimitedPath } from "@/api/lib/upload-rate-limit";

export const documentTranslationsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/document-translations",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.translate.duration,
      max: API_RATE_LIMITS.translate.max,
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "translate",
      }),
      skip: (req) => !isTranslateRateLimitedPath(new URL(req.url).pathname),
    }),
  )
  .guard({ validateWorkspaceAccess: true })
  .post("/prepare", prepareDocumentTranslation.handler, {
    body: prepareDocumentTranslation.config.body,
    params: prepareDocumentTranslation.config.params,
    permissions: prepareDocumentTranslation.config.permissions,
  })
  .post("/runs", createDocumentTranslationRun.handler, {
    body: createDocumentTranslationRun.config.body,
    params: createDocumentTranslationRun.config.params,
    permissions: createDocumentTranslationRun.config.permissions,
  })
  .get("/runs/:runId", readDocumentTranslationRun.handler, {
    params: readDocumentTranslationRun.config.params,
    permissions: readDocumentTranslationRun.config.permissions,
  });
