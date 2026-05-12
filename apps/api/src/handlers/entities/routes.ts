import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import checkStamp from "@/api/handlers/entities/check-stamp";
import clipEndpoint from "@/api/handlers/entities/clip";
import compareVersions from "@/api/handlers/entities/compare-versions";
import createEntities from "@/api/handlers/entities/create";
import createFromLegalSource from "@/api/handlers/entities/create-from-legal-source";
import deleteEntities from "@/api/handlers/entities/delete";
import deleteVersion from "@/api/handlers/entities/delete-version";
import downloadZip from "@/api/handlers/entities/download-zip";
import duplicateEntity from "@/api/handlers/entities/duplicate";
import listFiles from "@/api/handlers/entities/list-files";
import listFolders from "@/api/handlers/entities/list-folders";
import moveEntity from "@/api/handlers/entities/move";
import openDesktopEditSession from "@/api/handlers/entities/open-desktop-edit-session";
import organizeSuggestions from "@/api/handlers/entities/organize-suggestions";
import readEntities from "@/api/handlers/entities/read";
import readEntityById from "@/api/handlers/entities/read-by-id";
import readKanbanGroup from "@/api/handlers/entities/read-kanban-group";
import readEntitySummaries from "@/api/handlers/entities/read-summaries";
import readVersionById from "@/api/handlers/entities/read-version-by-id";
import readVersions from "@/api/handlers/entities/read-versions";
import readEntitiesWindow from "@/api/handlers/entities/read-window";
import releaseDesktopEditLock from "@/api/handlers/entities/release-desktop-edit-lock";
import renameEntity from "@/api/handlers/entities/rename";
import requestDesktopEditTakeover from "@/api/handlers/entities/request-desktop-edit-takeover";
import restoreVersion from "@/api/handlers/entities/restore-version";
import updateVersionDescription from "@/api/handlers/entities/update-version-description";
import updateVersionLabel from "@/api/handlers/entities/update-version-label";
import uploadEntity from "@/api/handlers/entities/upload";
import { isUploadRateLimitedPath } from "@/api/handlers/entities/upload-rate-limit";
import uploadVersion from "@/api/handlers/entities/upload-version";
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
      skip: (req) => !isUploadRateLimitedPath(new URL(req.url).pathname),
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
  .post("/desktop-edit-sessions/release", releaseDesktopEditLock.handler, {
    body: releaseDesktopEditLock.config.body,
    invalidateQuery: true,
  })
  .post(
    "/desktop-edit-sessions/request-takeover",
    requestDesktopEditTakeover.handler,
    {
      body: requestDesktopEditTakeover.config.body,
    },
  )
  .post("/clip", clipEndpoint.handler, {
    ...clipEndpoint.config,
    invalidateQuery: true,
  })
  .post("/create-from-legal-source", createFromLegalSource.handler, {
    body: createFromLegalSource.config.body,
    invalidateQuery: true,
  })
  .post("/query", readEntities.handler, {
    body: readEntities.config.body,
  })
  .post("/query-window", readEntitiesWindow.handler, {
    body: readEntitiesWindow.config.body,
  })
  .post("/kanban-group", readKanbanGroup.handler, {
    body: readKanbanGroup.config.body,
  })
  .post("/organize-suggestions", organizeSuggestions.handler, {
    body: organizeSuggestions.config.body,
  })
  .get("/folders", listFolders.handler)
  .get("/files", listFiles.handler)
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
  })
  .get("/entity/:entityId/versions", readVersions.handler, {
    params: readVersions.config.params,
  })
  .get("/entity/:entityId/versions/:versionId", readVersionById.handler, {
    params: readVersionById.config.params,
  })
  .post("/entity/:entityId/compare", compareVersions.handler, {
    body: compareVersions.config.body,
    params: compareVersions.config.params,
  })
  .patch(
    "/entity/:entityId/versions/:versionId/label",
    updateVersionLabel.handler,
    {
      body: updateVersionLabel.config.body,
      params: updateVersionLabel.config.params,
      invalidateQuery: true,
    },
  )
  .patch(
    "/entity/:entityId/versions/:versionId/description",
    updateVersionDescription.handler,
    {
      body: updateVersionDescription.config.body,
      params: updateVersionDescription.config.params,
      invalidateQuery: true,
    },
  )
  .post(
    "/entity/:entityId/versions/:versionId/restore",
    restoreVersion.handler,
    { invalidateQuery: true, params: restoreVersion.config.params },
  )
  .delete("/entity/:entityId/versions/:versionId", deleteVersion.handler, {
    invalidateQuery: true,
    params: deleteVersion.config.params,
  })
  .post("/upload-version", uploadVersion.handler, {
    body: uploadVersion.config.body,
    invalidateQuery: true,
  });
