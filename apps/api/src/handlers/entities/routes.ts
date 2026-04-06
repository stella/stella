import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import checkStamp from "@/api/handlers/entities/check-stamp";
import clipEndpoint from "@/api/handlers/entities/clip";
import createEntities from "@/api/handlers/entities/create";
import deleteEntities from "@/api/handlers/entities/delete";
import downloadZip from "@/api/handlers/entities/download-zip";
import duplicateEntity from "@/api/handlers/entities/duplicate";
import moveEntity from "@/api/handlers/entities/move";
import openDesktopEditSession from "@/api/handlers/entities/open-desktop-edit-session";
import readEntities from "@/api/handlers/entities/read";
import readEntityById from "@/api/handlers/entities/read-by-id";
import readEntitySummaries from "@/api/handlers/entities/read-summaries";
import renameEntity from "@/api/handlers/entities/rename";
import uploadEntity from "@/api/handlers/entities/upload";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit";

export const entitiesRoute = new Elysia({
  prefix: "/entities/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
      generator: scopedGenerator("upload"),
      context: new InMemoryRateLimitContext(),
      skip: (req) =>
        !/\/entities\/[^/]+\/upload$/.test(new URL(req.url).pathname),
    }),
  )
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createEntities.handler, {
    body: createEntities.config.body,
    invalidateQuery: true,
  })
  .post("/upload", uploadEntity.handler, {
    body: uploadEntity.config.body,
    invalidateQuery: true,
  })
  .post("/desktop-edit-sessions/open", openDesktopEditSession.handler, {
    body: openDesktopEditSession.config.body,
  })
  .post("/clip", clipEndpoint.handler, {
    ...clipEndpoint.config,
    invalidateQuery: true,
  })
  .post("/query", readEntities.handler, {
    body: readEntities.config.body,
  })
  .delete("/", deleteEntities.handler, {
    body: deleteEntities.config.body,
    invalidateQuery: true,
  })
  .patch("/move", moveEntity.handler, {
    body: moveEntity.config.body,
    invalidateQuery: true,
  })
  .patch("/rename", renameEntity.handler, {
    body: renameEntity.config.body,
    invalidateQuery: true,
  })
  .post("/duplicate", duplicateEntity.handler, {
    body: duplicateEntity.config.body,
    invalidateQuery: true,
  })
  .post("/check-stamp", checkStamp.handler, {
    body: checkStamp.config.body,
  })
  .get("/summaries", readEntitySummaries.handler, {
    query: readEntitySummaries.config.query,
  })
  .get("/zip/:entityId", downloadZip.handler, {
    params: downloadZip.config.params,
  })
  .get("/entity/:entityId", readEntityById.handler, {
    params: readEntityById.config.params,
  });
