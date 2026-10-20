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
  .put(
    "/",
    {
      body: createEntities.config.body,
      permissions: createEntities.config.permissions,
    },
    createEntities.handler,
  )
  .put(
    "/blank-document",
    {
      body: createBlankDocument.config.body,
      permissions: createBlankDocument.config.permissions,
    },
    createBlankDocument.handler,
  )
  .put(
    "/blank-document-from-style-set",
    {
      body: createDocumentFromStyleSet.config.body,
      permissions: createDocumentFromStyleSet.config.permissions,
    },
    createDocumentFromStyleSet.handler,
  )
  .post(
    ENTITY_UPLOAD_ROUTE_PATHS.entity,
    {
      body: uploadEntity.config.body,
      permissions: uploadEntity.config.permissions,
    },
    uploadEntity.handler,
  )
  .post(
    ENTITY_UPLOAD_ROUTE_PATHS.generatedDocument,
    {
      body: uploadGeneratedDocument.config.body,
      permissions: uploadGeneratedDocument.config.permissions,
    },
    uploadGeneratedDocument.handler,
  )
  .post(
    "/desktop-edit-sessions/open",
    {
      body: openDesktopEditSession.config.body,
      permissions: openDesktopEditSession.config.permissions,
    },
    openDesktopEditSession.handler,
  )
  .post(
    "/desktop-edit-handoffs",
    {
      body: createDesktopEditHandoff.config.body,
      permissions: createDesktopEditHandoff.config.permissions,
    },
    createDesktopEditHandoff.handler,
  )
  .get(
    "/desktop-edit-handoffs/:handoffId/status",
    {
      params: readDesktopEditHandoffStatus.config.params,
      permissions: readDesktopEditHandoffStatus.config.permissions,
    },
    readDesktopEditHandoffStatus.handler,
  )
  .post(
    "/pdf-signing-handoffs",
    {
      body: createPdfSigningHandoff.config.body,
      permissions: createPdfSigningHandoff.config.permissions,
    },
    createPdfSigningHandoff.handler,
  )
  .get(
    "/pdf-signing-sessions/:sessionId",
    {
      params: readPdfSigningSessionStatus.config.params,
      permissions: readPdfSigningSessionStatus.config.permissions,
    },
    readPdfSigningSessionStatus.handler,
  )
  .post(
    "/pdf-signing-sessions/:sessionId/cancel",
    {
      params: cancelPdfSigningSession.config.params,
      permissions: cancelPdfSigningSession.config.permissions,
    },
    cancelPdfSigningSession.handler,
  )
  .post(
    "/folio-collab-rooms/join",
    {
      body: joinFolioCollabRoom.config.body,
      permissions: joinFolioCollabRoom.config.permissions,
    },
    joinFolioCollabRoom.handler,
  )
  .post(
    "/folio-collab-rooms/checkpoint",
    {
      body: checkpointFolioCollabRoom.config.body,
      permissions: checkpointFolioCollabRoom.config.permissions,
    },
    checkpointFolioCollabRoom.handler,
  )
  .post(
    "/folio-collab-rooms/publish-version",
    {
      body: publishFolioCollabVersion.config.body,
      permissions: publishFolioCollabVersion.config.permissions,
    },
    publishFolioCollabVersion.handler,
  )
  .post(
    "/desktop-edit-sessions/release",
    {
      body: releaseDesktopEditLock.config.body,
      permissions: releaseDesktopEditLock.config.permissions,
    },
    releaseDesktopEditLock.handler,
  )
  .post(
    "/desktop-edit-sessions/request-takeover",
    {
      body: requestDesktopEditTakeover.config.body,
      permissions: requestDesktopEditTakeover.config.permissions,
    },
    requestDesktopEditTakeover.handler,
  )
  .post(
    "/clip",
    {
      ...clipEndpoint.config,
    },
    clipEndpoint.handler,
  )
  .post(
    "/create-from-legal-source",
    {
      body: createFromLegalSource.config.body,
      permissions: createFromLegalSource.config.permissions,
    },
    createFromLegalSource.handler,
  )
  .post(
    "/query",
    {
      body: readEntities.config.body,
      permissions: readEntities.config.permissions,
    },
    readEntities.handler,
  )
  .post(
    "/query-window",
    {
      body: readEntitiesWindow.config.body,
      permissions: readEntitiesWindow.config.permissions,
    },
    readEntitiesWindow.handler,
  )
  .post(
    "/filesystem-tree",
    {
      body: readFilesystemTree.config.body,
      permissions: readFilesystemTree.config.permissions,
    },
    readFilesystemTree.handler,
  )
  .post(
    "/kanban-group",
    {
      body: readKanbanGroup.config.body,
      permissions: readKanbanGroup.config.permissions,
    },
    readKanbanGroup.handler,
  )
  .post(
    "/group-counts",
    {
      body: readGroupCounts.config.body,
      permissions: readGroupCounts.config.permissions,
    },
    readGroupCounts.handler,
  )
  .post(
    "/property-facets",
    {
      body: readPropertyFacets.config.body,
      permissions: readPropertyFacets.config.permissions,
    },
    readPropertyFacets.handler,
  )
  .post(
    "/organize-suggestions",
    {
      body: organizeSuggestions.config.body,
      permissions: organizeSuggestions.config.permissions,
    },
    organizeSuggestions.handler,
  )
  .get(
    "/folders",
    {
      query: listFolders.config.query,
      permissions: listFolders.config.permissions,
    },
    listFolders.handler,
  )
  .get(
    "/files",
    {
      query: listFiles.config.query,
      permissions: listFiles.config.permissions,
    },
    listFiles.handler,
  )
  .delete(
    "/",
    {
      body: deleteEntities.config.body,
      permissions: deleteEntities.config.permissions,
    },
    deleteEntities.handler,
  )
  .patch(
    "/move",
    {
      body: moveEntity.config.body,
      permissions: moveEntity.config.permissions,
    },
    moveEntity.handler,
  )
  .patch(
    "/rename",
    {
      body: renameEntity.config.body,
      permissions: renameEntity.config.permissions,
    },
    renameEntity.handler,
  )
  .post(
    "/duplicate",
    {
      body: duplicateEntity.config.body,
      permissions: duplicateEntity.config.permissions,
    },
    duplicateEntity.handler,
  )
  .post(
    "/copy-to-workspace",
    {
      body: copyToWorkspace.config.body,
      permissions: copyToWorkspace.config.permissions,
    },
    copyToWorkspace.handler,
  )
  .post(
    "/check-stamp",
    {
      body: checkStamp.config.body,
      permissions: checkStamp.config.permissions,
    },
    checkStamp.handler,
  )
  .get(
    "/summaries/count",
    {
      permissions: readEntitySummariesCount.config.permissions,
      query: readEntitySummariesCount.config.query,
    },
    readEntitySummariesCount.handler,
  )
  .get(
    "/summaries",
    {
      permissions: readEntitySummaries.config.permissions,
      query: readEntitySummaries.config.query,
    },
    readEntitySummaries.handler,
  )
  .get(
    "/zip/:entityId",
    {
      params: downloadZip.config.params,
      permissions: downloadZip.config.permissions,
    },
    downloadZip.handler,
  )
  .get(
    "/entity/:entityId",
    {
      params: readEntityById.config.params,
      permissions: readEntityById.config.permissions,
    },
    readEntityById.handler,
  )
  .get(
    "/entity/:entityId/versions",
    {
      params: readVersions.config.params,
      query: readVersions.config.query,
      permissions: readVersions.config.permissions,
    },
    readVersions.handler,
  )
  .get(
    "/entity/:entityId/versions/:versionId",
    {
      params: readVersionById.config.params,
      permissions: readVersionById.config.permissions,
    },
    readVersionById.handler,
  )
  .get(
    "/entity/:entityId/field/:fieldId/file",
    {
      params: readFieldFile.config.params,
      permissions: readFieldFile.config.permissions,
    },
    readFieldFile.handler,
  )
  .post(
    "/entity/:entityId/ocr",
    {
      body: requestOcr.config.body,
      params: requestOcr.config.params,
      permissions: requestOcr.config.permissions,
    },
    requestOcr.handler,
  )
  .get(
    "/entity/:entityId/versions/:versionId/diff",
    {
      params: versionDiff.config.params,
      permissions: versionDiff.config.permissions,
    },
    versionDiff.handler,
  )
  .post(
    "/entity/:entityId/versions/:versionId/summarize",
    {
      params: versionSummarize.config.params,
      permissions: versionSummarize.config.permissions,
    },
    versionSummarize.handler,
  )
  .patch(
    "/entity/:entityId/versions/:versionId/label",
    {
      body: updateVersionLabel.config.body,
      params: updateVersionLabel.config.params,
      permissions: updateVersionLabel.config.permissions,
    },
    updateVersionLabel.handler,
  )
  .patch(
    "/entity/:entityId/versions/:versionId/description",
    {
      body: updateVersionDescription.config.body,
      params: updateVersionDescription.config.params,
      permissions: updateVersionDescription.config.permissions,
    },
    updateVersionDescription.handler,
  )
  .post(
    "/entity/:entityId/versions/:versionId/restore",
    {
      params: restoreVersion.config.params,
      permissions: restoreVersion.config.permissions,
    },
    restoreVersion.handler,
  )
  .delete(
    "/entity/:entityId/versions/:versionId",
    {
      params: deleteVersion.config.params,
      permissions: deleteVersion.config.permissions,
    },
    deleteVersion.handler,
  )
  .post(
    ENTITY_UPLOAD_ROUTE_PATHS.version,
    {
      body: uploadVersion.config.body,
      permissions: uploadVersion.config.permissions,
    },
    uploadVersion.handler,
  )
  .post(
    "/bilingual",
    {
      body: createBilingualEntity.config.body,
      permissions: createBilingualEntity.config.permissions,
    },
    createBilingualEntity.handler,
  );
