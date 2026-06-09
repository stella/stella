import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import checkStamp from "@/api/handlers/entities/check-stamp";
import clipEndpoint from "@/api/handlers/entities/clip";
import compareVersions from "@/api/handlers/entities/compare-versions";
import copyToWorkspace from "@/api/handlers/entities/copy-to-workspace";
import createEntities from "@/api/handlers/entities/create";
import createFromLegalSource from "@/api/handlers/entities/create-from-legal-source";
import deleteEntities from "@/api/handlers/entities/delete";
import deleteVersion from "@/api/handlers/entities/delete-version";
import createDesktopEditHandoff, {
  readDesktopEditHandoffStatus,
} from "@/api/handlers/entities/desktop-edit-handoffs";
import downloadZip from "@/api/handlers/entities/download-zip";
import duplicateEntity from "@/api/handlers/entities/duplicate";
import listFiles from "@/api/handlers/entities/list-files";
import listFolders from "@/api/handlers/entities/list-folders";
import moveEntity from "@/api/handlers/entities/move";
import openDesktopEditSession from "@/api/handlers/entities/open-desktop-edit-session";
import openFolioCollabSession from "@/api/handlers/entities/open-folio-collab-session";
import organizeSuggestions from "@/api/handlers/entities/organize-suggestions";
import readEntities from "@/api/handlers/entities/read";
import readEntityById from "@/api/handlers/entities/read-by-id";
import readFilesystemTree from "@/api/handlers/entities/read-filesystem-tree";
import readKanbanGroup from "@/api/handlers/entities/read-kanban-group";
import readEntitySummaries from "@/api/handlers/entities/read-summaries";
import readVersionById from "@/api/handlers/entities/read-version-by-id";
import readVersions from "@/api/handlers/entities/read-versions";
import readEntitiesWindow from "@/api/handlers/entities/read-window";
import releaseDesktopEditLock from "@/api/handlers/entities/release-desktop-edit-lock";
import renameEntity from "@/api/handlers/entities/rename";
import requestDesktopEditTakeover from "@/api/handlers/entities/request-desktop-edit-takeover";
import restoreVersion from "@/api/handlers/entities/restore-version";
import translateEntity from "@/api/handlers/entities/translate";
import updateVersionDescription from "@/api/handlers/entities/update-version-description";
import updateVersionLabel from "@/api/handlers/entities/update-version-label";
import uploadEntity from "@/api/handlers/entities/upload";
import {
  isTranslateRateLimitedPath,
  isUploadRateLimitedPath,
} from "@/api/handlers/entities/upload-rate-limit";
import uploadVersion from "@/api/handlers/entities/upload-version";
import versionDiff from "@/api/handlers/entities/version-diff";
import versionSummarize from "@/api/handlers/entities/version-summarize";
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
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.translate.duration,
      max: API_RATE_LIMITS.translate.max,
      generator: scopedGenerator("translate"),
      context: new InMemoryRateLimitContext(),
      skip: (req) => !isTranslateRateLimitedPath(new URL(req.url).pathname),
    }),
  )
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createEntities.handler, {
    body: createEntities.config.body,
    invalidateQuery: true,
    permissions: createEntities.config.permissions,
  })
  .post("/upload", uploadEntity.handler, {
    body: uploadEntity.config.body,
    invalidateQuery: true,
    permissions: uploadEntity.config.permissions,
  })
  .post("/desktop-edit-sessions/open", openDesktopEditSession.handler, {
    body: openDesktopEditSession.config.body,
    permissions: openDesktopEditSession.config.permissions,
  })
  .post("/desktop-edit-handoffs", createDesktopEditHandoff.handler, {
    body: createDesktopEditHandoff.config.body,
    permissions: createDesktopEditHandoff.config.permissions,
  })
  .get(
    "/desktop-edit-handoffs/:handoffId/status",
    readDesktopEditHandoffStatus.handler,
    {
      params: readDesktopEditHandoffStatus.config.params,
      permissions: readDesktopEditHandoffStatus.config.permissions,
    },
  )
  .post("/folio-collab-sessions/open", openFolioCollabSession.handler, {
    body: openFolioCollabSession.config.body,
    permissions: openFolioCollabSession.config.permissions,
  })
  .post("/desktop-edit-sessions/release", releaseDesktopEditLock.handler, {
    body: releaseDesktopEditLock.config.body,
    invalidateQuery: true,
    permissions: releaseDesktopEditLock.config.permissions,
  })
  .post(
    "/desktop-edit-sessions/request-takeover",
    requestDesktopEditTakeover.handler,
    {
      body: requestDesktopEditTakeover.config.body,
      permissions: requestDesktopEditTakeover.config.permissions,
    },
  )
  .post("/clip", clipEndpoint.handler, {
    ...clipEndpoint.config,
    invalidateQuery: true,
  })
  .post("/create-from-legal-source", createFromLegalSource.handler, {
    body: createFromLegalSource.config.body,
    invalidateQuery: true,
    permissions: createFromLegalSource.config.permissions,
  })
  .post("/query", readEntities.handler, {
    body: readEntities.config.body,
    permissions: readEntities.config.permissions,
  })
  .post("/query-window", readEntitiesWindow.handler, {
    body: readEntitiesWindow.config.body,
    permissions: readEntitiesWindow.config.permissions,
  })
  .post("/filesystem-tree", readFilesystemTree.handler, {
    body: readFilesystemTree.config.body,
    permissions: readFilesystemTree.config.permissions,
  })
  .post("/kanban-group", readKanbanGroup.handler, {
    body: readKanbanGroup.config.body,
    permissions: readKanbanGroup.config.permissions,
  })
  .post("/organize-suggestions", organizeSuggestions.handler, {
    body: organizeSuggestions.config.body,
    permissions: organizeSuggestions.config.permissions,
  })
  .get("/folders", listFolders.handler, {
    query: listFolders.config.query,
    permissions: listFolders.config.permissions,
  })
  .get("/files", listFiles.handler, {
    query: listFiles.config.query,
    permissions: listFiles.config.permissions,
  })
  .delete("/", deleteEntities.handler, {
    body: deleteEntities.config.body,
    invalidateQuery: true,
    permissions: deleteEntities.config.permissions,
  })
  .patch("/move", moveEntity.handler, {
    body: moveEntity.config.body,
    invalidateQuery: true,
    permissions: moveEntity.config.permissions,
  })
  .patch("/rename", renameEntity.handler, {
    body: renameEntity.config.body,
    invalidateQuery: true,
    permissions: renameEntity.config.permissions,
  })
  .post("/duplicate", duplicateEntity.handler, {
    body: duplicateEntity.config.body,
    invalidateQuery: true,
    permissions: duplicateEntity.config.permissions,
  })
  .post("/copy-to-workspace", copyToWorkspace.handler, {
    body: copyToWorkspace.config.body,
    invalidateQuery: true,
    permissions: copyToWorkspace.config.permissions,
  })
  .post("/check-stamp", checkStamp.handler, {
    body: checkStamp.config.body,
    permissions: checkStamp.config.permissions,
  })
  .get("/summaries", readEntitySummaries.handler, {
    permissions: readEntitySummaries.config.permissions,
    query: readEntitySummaries.config.query,
  })
  .get("/zip/:entityId", downloadZip.handler, {
    params: downloadZip.config.params,
    permissions: downloadZip.config.permissions,
  })
  .get("/entity/:entityId", readEntityById.handler, {
    params: readEntityById.config.params,
    permissions: readEntityById.config.permissions,
  })
  .get("/entity/:entityId/versions", readVersions.handler, {
    params: readVersions.config.params,
    permissions: readVersions.config.permissions,
  })
  .get("/entity/:entityId/versions/:versionId", readVersionById.handler, {
    params: readVersionById.config.params,
    permissions: readVersionById.config.permissions,
  })
  .get("/entity/:entityId/versions/:versionId/diff", versionDiff.handler, {
    params: versionDiff.config.params,
    permissions: versionDiff.config.permissions,
  })
  .post(
    "/entity/:entityId/versions/:versionId/summarize",
    versionSummarize.handler,
    {
      params: versionSummarize.config.params,
      permissions: versionSummarize.config.permissions,
    },
  )
  .post("/entity/:entityId/compare", compareVersions.handler, {
    body: compareVersions.config.body,
    params: compareVersions.config.params,
    permissions: compareVersions.config.permissions,
  })
  .patch(
    "/entity/:entityId/versions/:versionId/label",
    updateVersionLabel.handler,
    {
      body: updateVersionLabel.config.body,
      invalidateQuery: true,
      params: updateVersionLabel.config.params,
      permissions: updateVersionLabel.config.permissions,
    },
  )
  .patch(
    "/entity/:entityId/versions/:versionId/description",
    updateVersionDescription.handler,
    {
      body: updateVersionDescription.config.body,
      invalidateQuery: true,
      params: updateVersionDescription.config.params,
      permissions: updateVersionDescription.config.permissions,
    },
  )
  .post(
    "/entity/:entityId/versions/:versionId/restore",
    restoreVersion.handler,
    {
      invalidateQuery: true,
      params: restoreVersion.config.params,
      permissions: restoreVersion.config.permissions,
    },
  )
  .delete("/entity/:entityId/versions/:versionId", deleteVersion.handler, {
    invalidateQuery: true,
    params: deleteVersion.config.params,
    permissions: deleteVersion.config.permissions,
  })
  .post("/upload-version", uploadVersion.handler, {
    body: uploadVersion.config.body,
    invalidateQuery: true,
    permissions: uploadVersion.config.permissions,
  })
  .post("/translate", translateEntity.handler, {
    body: translateEntity.config.body,
    invalidateQuery: true,
    permissions: translateEntity.config.permissions,
  });
