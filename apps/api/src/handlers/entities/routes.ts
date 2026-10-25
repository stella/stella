import Elysia from "elysia";

import createBilingualEntity from "@/api/handlers/entities/bilingual/create";
import createBlankDocument from "@/api/handlers/entities/blank-document/create";
import checkpointFolioCollabRoom from "@/api/handlers/entities/checkpoint-folio-collab-room";
import clipEndpoint from "@/api/handlers/entities/clip";
import copyToWorkspace from "@/api/handlers/entities/copy";
import createEntities from "@/api/handlers/entities/create";
import createDocumentFromStyleSet from "@/api/handlers/entities/create-document-from-style-set";
import deleteEntities from "@/api/handlers/entities/delete";
import createDesktopEditHandoff, {
  readDesktopEditHandoffStatus,
} from "@/api/handlers/entities/desktop-edit-handoffs";
import duplicateEntity from "@/api/handlers/entities/duplicate";
import listFiles from "@/api/handlers/entities/files/list";
import readFilesystemTree from "@/api/handlers/entities/filesystem-tree/get";
import createFolderFromSelection from "@/api/handlers/entities/folder-from-selection/create";
import listFolders from "@/api/handlers/entities/folders/list";
import createFromLegalSource from "@/api/handlers/entities/from-legal-source/create";
import readEntityById from "@/api/handlers/entities/get";
import joinFolioCollabRoom from "@/api/handlers/entities/join-folio-collab-room";
import readEntities from "@/api/handlers/entities/list";
import moveEntity from "@/api/handlers/entities/move";
import requestOcr from "@/api/handlers/entities/ocr/create";
import openDesktopEditSession from "@/api/handlers/entities/open-desktop-edit-session";
import createPdfSigningHandoff from "@/api/handlers/entities/pdf-signing-handoffs";
import {
  cancelPdfSigningSession,
  readPdfSigningSessionStatus,
} from "@/api/handlers/entities/pdf-signing-sessions";
import organizeSuggestions from "@/api/handlers/entities/placements/suggest";
import publishFolioCollabVersion from "@/api/handlers/entities/publish-folio-collab-version";
import readFieldFile from "@/api/handlers/entities/read-field-file";
import readGroupCounts from "@/api/handlers/entities/read-group-counts";
import readKanbanGroup from "@/api/handlers/entities/read-kanban-group";
import readPropertyFacets from "@/api/handlers/entities/read-property-facets";
import releaseDesktopEditLock from "@/api/handlers/entities/release-desktop-edit-lock";
import renameEntity from "@/api/handlers/entities/rename";
import requestDesktopEditTakeover from "@/api/handlers/entities/request-desktop-edit-takeover";
import checkStamp from "@/api/handlers/entities/stamps/check";
import readEntitySummariesCount from "@/api/handlers/entities/summaries/count";
import readEntitySummaries from "@/api/handlers/entities/summaries/list";
import uploadEntity, {
  uploadGeneratedDocument,
} from "@/api/handlers/entities/upload";
import deleteVersion from "@/api/handlers/entities/versions/delete";
import updateVersionDescription from "@/api/handlers/entities/versions/description/update";
import versionDiff from "@/api/handlers/entities/versions/diff";
import readVersionById from "@/api/handlers/entities/versions/get";
import updateVersionLabel from "@/api/handlers/entities/versions/label/update";
import readVersions from "@/api/handlers/entities/versions/list";
import restoreVersion from "@/api/handlers/entities/versions/restore";
import versionSummarize from "@/api/handlers/entities/versions/summarize";
import uploadVersion from "@/api/handlers/entities/versions/upload";
import readEntitiesWindow from "@/api/handlers/entities/window/list";
import downloadZip from "@/api/handlers/entities/zip/download";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  ENTITY_UPLOAD_ROUTE_PATHS,
  isTranslateRateLimitedPath,
  isUploadRateLimitedPath,
} from "@/api/lib/upload-rate-limit";

export const entitiesRoute = new Elysia({
  prefix: "/entities/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
      budget: { name: "api.upload.address", keyKind: "address" },
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "upload",
      }),
      skip: (req) => !isUploadRateLimitedPath(new URL(req.url).pathname),
    }),
  )
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.translate.duration,
      max: API_RATE_LIMITS.translate.max,
      budget: { name: "api.translate.address", keyKind: "address" },
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "translate",
      }),
      skip: (req) => !isTranslateRateLimitedPath(new URL(req.url).pathname),
    }),
  )
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createEntities.handler, {
    body: createEntities.config.body,
    permissions: createEntities.config.permissions,
    accountAccess: createEntities.config.accountAccess,
  })
  .put("/blank-document", createBlankDocument.handler, {
    body: createBlankDocument.config.body,
    permissions: createBlankDocument.config.permissions,
    accountAccess: createBlankDocument.config.accountAccess,
  })
  .put("/blank-document-from-style-set", createDocumentFromStyleSet.handler, {
    body: createDocumentFromStyleSet.config.body,
    permissions: createDocumentFromStyleSet.config.permissions,
    accountAccess: createDocumentFromStyleSet.config.accountAccess,
  })
  .post(ENTITY_UPLOAD_ROUTE_PATHS.entity, uploadEntity.handler, {
    body: uploadEntity.config.body,
    permissions: uploadEntity.config.permissions,
    accountAccess: uploadEntity.config.accountAccess,
  })
  .post(
    ENTITY_UPLOAD_ROUTE_PATHS.generatedDocument,
    uploadGeneratedDocument.handler,
    {
      body: uploadGeneratedDocument.config.body,
      permissions: uploadGeneratedDocument.config.permissions,
      accountAccess: uploadGeneratedDocument.config.accountAccess,
    },
  )
  .post("/desktop-edit-sessions/open", openDesktopEditSession.handler, {
    body: openDesktopEditSession.config.body,
    permissions: openDesktopEditSession.config.permissions,
    accountAccess: openDesktopEditSession.config.accountAccess,
  })
  .post("/desktop-edit-handoffs", createDesktopEditHandoff.handler, {
    body: createDesktopEditHandoff.config.body,
    permissions: createDesktopEditHandoff.config.permissions,
    accountAccess: createDesktopEditHandoff.config.accountAccess,
  })
  .get(
    "/desktop-edit-handoffs/:handoffId/status",
    readDesktopEditHandoffStatus.handler,
    {
      params: readDesktopEditHandoffStatus.config.params,
      permissions: readDesktopEditHandoffStatus.config.permissions,
      accountAccess: readDesktopEditHandoffStatus.config.accountAccess,
    },
  )
  .post("/pdf-signing-handoffs", createPdfSigningHandoff.handler, {
    body: createPdfSigningHandoff.config.body,
    permissions: createPdfSigningHandoff.config.permissions,
    accountAccess: createPdfSigningHandoff.config.accountAccess,
  })
  .get(
    "/pdf-signing-sessions/:sessionId",
    readPdfSigningSessionStatus.handler,
    {
      params: readPdfSigningSessionStatus.config.params,
      permissions: readPdfSigningSessionStatus.config.permissions,
      accountAccess: readPdfSigningSessionStatus.config.accountAccess,
    },
  )
  .post(
    "/pdf-signing-sessions/:sessionId/cancel",
    cancelPdfSigningSession.handler,
    {
      params: cancelPdfSigningSession.config.params,
      permissions: cancelPdfSigningSession.config.permissions,
      accountAccess: cancelPdfSigningSession.config.accountAccess,
    },
  )
  .post("/folio-collab-rooms/join", joinFolioCollabRoom.handler, {
    body: joinFolioCollabRoom.config.body,
    permissions: joinFolioCollabRoom.config.permissions,
    accountAccess: joinFolioCollabRoom.config.accountAccess,
  })
  .post("/folio-collab-rooms/checkpoint", checkpointFolioCollabRoom.handler, {
    body: checkpointFolioCollabRoom.config.body,
    permissions: checkpointFolioCollabRoom.config.permissions,
    accountAccess: checkpointFolioCollabRoom.config.accountAccess,
  })
  .post(
    "/folio-collab-rooms/publish-version",
    publishFolioCollabVersion.handler,
    {
      body: publishFolioCollabVersion.config.body,
      permissions: publishFolioCollabVersion.config.permissions,
      accountAccess: publishFolioCollabVersion.config.accountAccess,
    },
  )
  .post("/desktop-edit-sessions/release", releaseDesktopEditLock.handler, {
    body: releaseDesktopEditLock.config.body,
    permissions: releaseDesktopEditLock.config.permissions,
    accountAccess: releaseDesktopEditLock.config.accountAccess,
  })
  .post(
    "/desktop-edit-sessions/request-takeover",
    requestDesktopEditTakeover.handler,
    {
      body: requestDesktopEditTakeover.config.body,
      permissions: requestDesktopEditTakeover.config.permissions,
      accountAccess: requestDesktopEditTakeover.config.accountAccess,
    },
  )
  .post("/clip", clipEndpoint.handler, {
    ...clipEndpoint.config,
  })
  .post("/create-from-legal-source", createFromLegalSource.handler, {
    body: createFromLegalSource.config.body,
    permissions: createFromLegalSource.config.permissions,
    accountAccess: createFromLegalSource.config.accountAccess,
  })
  .post("/query", readEntities.handler, {
    body: readEntities.config.body,
    permissions: readEntities.config.permissions,
    accountAccess: readEntities.config.accountAccess,
  })
  .post("/query-window", readEntitiesWindow.handler, {
    body: readEntitiesWindow.config.body,
    permissions: readEntitiesWindow.config.permissions,
    accountAccess: readEntitiesWindow.config.accountAccess,
  })
  .post("/filesystem-tree", readFilesystemTree.handler, {
    body: readFilesystemTree.config.body,
    permissions: readFilesystemTree.config.permissions,
    accountAccess: readFilesystemTree.config.accountAccess,
  })
  .post("/kanban-group", readKanbanGroup.handler, {
    body: readKanbanGroup.config.body,
    permissions: readKanbanGroup.config.permissions,
    accountAccess: readKanbanGroup.config.accountAccess,
  })
  .post("/group-counts", readGroupCounts.handler, {
    body: readGroupCounts.config.body,
    permissions: readGroupCounts.config.permissions,
    accountAccess: readGroupCounts.config.accountAccess,
  })
  .post("/property-facets", readPropertyFacets.handler, {
    body: readPropertyFacets.config.body,
    permissions: readPropertyFacets.config.permissions,
    accountAccess: readPropertyFacets.config.accountAccess,
  })
  .post("/organize-suggestions", organizeSuggestions.handler, {
    body: organizeSuggestions.config.body,
    permissions: organizeSuggestions.config.permissions,
    accountAccess: organizeSuggestions.config.accountAccess,
  })
  .get("/folders", listFolders.handler, {
    query: listFolders.config.query,
    permissions: listFolders.config.permissions,
    accountAccess: listFolders.config.accountAccess,
  })
  .get("/files", listFiles.handler, {
    query: listFiles.config.query,
    permissions: listFiles.config.permissions,
    accountAccess: listFiles.config.accountAccess,
  })
  .delete("/", deleteEntities.handler, {
    body: deleteEntities.config.body,
    permissions: deleteEntities.config.permissions,
    accountAccess: deleteEntities.config.accountAccess,
  })
  .patch("/move", moveEntity.handler, {
    body: moveEntity.config.body,
    permissions: moveEntity.config.permissions,
    accountAccess: moveEntity.config.accountAccess,
  })
  .post("/folder-from-selection", createFolderFromSelection.handler, {
    body: createFolderFromSelection.config.body,
    permissions: createFolderFromSelection.config.permissions,
    accountAccess: createFolderFromSelection.config.accountAccess,
  })
  .patch("/rename", renameEntity.handler, {
    body: renameEntity.config.body,
    permissions: renameEntity.config.permissions,
    accountAccess: renameEntity.config.accountAccess,
  })
  .post("/duplicate", duplicateEntity.handler, {
    body: duplicateEntity.config.body,
    permissions: duplicateEntity.config.permissions,
    accountAccess: duplicateEntity.config.accountAccess,
  })
  .post("/copy-to-workspace", copyToWorkspace.handler, {
    body: copyToWorkspace.config.body,
    permissions: copyToWorkspace.config.permissions,
    accountAccess: copyToWorkspace.config.accountAccess,
  })
  .post("/check-stamp", checkStamp.handler, {
    body: checkStamp.config.body,
    permissions: checkStamp.config.permissions,
    accountAccess: checkStamp.config.accountAccess,
  })
  .get("/summaries/count", readEntitySummariesCount.handler, {
    permissions: readEntitySummariesCount.config.permissions,
    accountAccess: readEntitySummariesCount.config.accountAccess,
    query: readEntitySummariesCount.config.query,
  })
  .get("/summaries", readEntitySummaries.handler, {
    permissions: readEntitySummaries.config.permissions,
    accountAccess: readEntitySummaries.config.accountAccess,
    query: readEntitySummaries.config.query,
  })
  .get("/zip/:entityId", downloadZip.handler, {
    params: downloadZip.config.params,
    permissions: downloadZip.config.permissions,
    accountAccess: downloadZip.config.accountAccess,
  })
  .get("/entity/:entityId", readEntityById.handler, {
    params: readEntityById.config.params,
    permissions: readEntityById.config.permissions,
    accountAccess: readEntityById.config.accountAccess,
  })
  .get("/entity/:entityId/versions", readVersions.handler, {
    params: readVersions.config.params,
    query: readVersions.config.query,
    permissions: readVersions.config.permissions,
    accountAccess: readVersions.config.accountAccess,
  })
  .get("/entity/:entityId/versions/:versionId", readVersionById.handler, {
    params: readVersionById.config.params,
    permissions: readVersionById.config.permissions,
    accountAccess: readVersionById.config.accountAccess,
  })
  .get("/entity/:entityId/field/:fieldId/file", readFieldFile.handler, {
    params: readFieldFile.config.params,
    permissions: readFieldFile.config.permissions,
    accountAccess: readFieldFile.config.accountAccess,
  })
  .post("/entity/:entityId/ocr", requestOcr.handler, {
    body: requestOcr.config.body,
    params: requestOcr.config.params,
    permissions: requestOcr.config.permissions,
    accountAccess: requestOcr.config.accountAccess,
  })
  .get("/entity/:entityId/versions/:versionId/diff", versionDiff.handler, {
    params: versionDiff.config.params,
    permissions: versionDiff.config.permissions,
    accountAccess: versionDiff.config.accountAccess,
  })
  .post(
    "/entity/:entityId/versions/:versionId/summarize",
    versionSummarize.handler,
    {
      params: versionSummarize.config.params,
      permissions: versionSummarize.config.permissions,
      accountAccess: versionSummarize.config.accountAccess,
    },
  )
  .patch(
    "/entity/:entityId/versions/:versionId/label",
    updateVersionLabel.handler,
    {
      body: updateVersionLabel.config.body,
      params: updateVersionLabel.config.params,
      permissions: updateVersionLabel.config.permissions,
      accountAccess: updateVersionLabel.config.accountAccess,
    },
  )
  .patch(
    "/entity/:entityId/versions/:versionId/description",
    updateVersionDescription.handler,
    {
      body: updateVersionDescription.config.body,
      params: updateVersionDescription.config.params,
      permissions: updateVersionDescription.config.permissions,
      accountAccess: updateVersionDescription.config.accountAccess,
    },
  )
  .post(
    "/entity/:entityId/versions/:versionId/restore",
    restoreVersion.handler,
    {
      params: restoreVersion.config.params,
      permissions: restoreVersion.config.permissions,
      accountAccess: restoreVersion.config.accountAccess,
    },
  )
  .delete("/entity/:entityId/versions/:versionId", deleteVersion.handler, {
    params: deleteVersion.config.params,
    permissions: deleteVersion.config.permissions,
    accountAccess: deleteVersion.config.accountAccess,
  })
  .post(ENTITY_UPLOAD_ROUTE_PATHS.version, uploadVersion.handler, {
    body: uploadVersion.config.body,
    permissions: uploadVersion.config.permissions,
    accountAccess: uploadVersion.config.accountAccess,
  })
  .post("/bilingual", createBilingualEntity.handler, {
    body: createBilingualEntity.config.body,
    permissions: createBilingualEntity.config.permissions,
    accountAccess: createBilingualEntity.config.accountAccess,
  });
