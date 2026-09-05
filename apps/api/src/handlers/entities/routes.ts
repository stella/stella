import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import createBilingualEntity from "@/api/handlers/entities/bilingual/create";
import checkStamp from "@/api/handlers/entities/check-stamp";
import checkpointFolioCollabRoom from "@/api/handlers/entities/checkpoint-folio-collab-room";
import clipEndpoint from "@/api/handlers/entities/clip";
import compareVersions from "@/api/handlers/entities/compare-versions";
import copyToWorkspace from "@/api/handlers/entities/copy-to-workspace";
import createEntities from "@/api/handlers/entities/create";
import createBlankDocument from "@/api/handlers/entities/create-blank-document";
import createDocumentFromStyleSet from "@/api/handlers/entities/create-document-from-style-set";
import createFromLegalSource from "@/api/handlers/entities/create-from-legal-source";
import deleteEntities from "@/api/handlers/entities/delete";
import deleteVersion from "@/api/handlers/entities/delete-version";
import createDesktopEditHandoff, {
  readDesktopEditHandoffStatus,
} from "@/api/handlers/entities/desktop-edit-handoffs";
import downloadZip from "@/api/handlers/entities/download-zip";
import duplicateEntity from "@/api/handlers/entities/duplicate";
import readEntityById from "@/api/handlers/entities/get";
import joinFolioCollabRoom from "@/api/handlers/entities/join-folio-collab-room";
import readEntities from "@/api/handlers/entities/list";
import listFiles from "@/api/handlers/entities/list-files";
import listFolders from "@/api/handlers/entities/list-folders";
import moveEntity from "@/api/handlers/entities/move";
import requestOcr from "@/api/handlers/entities/ocr/create";
import openDesktopEditSession from "@/api/handlers/entities/open-desktop-edit-session";
import organizeSuggestions from "@/api/handlers/entities/organize-suggestions";
import publishFolioCollabVersion from "@/api/handlers/entities/publish-folio-collab-version";
import readFieldFile from "@/api/handlers/entities/read-field-file";
import readFilesystemTree from "@/api/handlers/entities/read-filesystem-tree";
import readGroupCounts from "@/api/handlers/entities/read-group-counts";
import readKanbanGroup from "@/api/handlers/entities/read-kanban-group";
import readPropertyFacets from "@/api/handlers/entities/read-property-facets";
import readEntitySummaries from "@/api/handlers/entities/read-summaries";
import readEntitySummariesCount from "@/api/handlers/entities/read-summaries-count";
import readVersionById from "@/api/handlers/entities/read-version-by-id";
import readVersions from "@/api/handlers/entities/read-versions";
import readEntitiesWindow from "@/api/handlers/entities/read-window";
import releaseDesktopEditLock from "@/api/handlers/entities/release-desktop-edit-lock";
import renameEntity from "@/api/handlers/entities/rename";
import requestDesktopEditTakeover from "@/api/handlers/entities/request-desktop-edit-takeover";
import restoreVersion from "@/api/handlers/entities/restore-version";
import updateVersionDescription from "@/api/handlers/entities/update-version-description";
import updateVersionLabel from "@/api/handlers/entities/update-version-label";
import uploadEntity, {
  uploadGeneratedDocument,
} from "@/api/handlers/entities/upload";
import uploadVersion from "@/api/handlers/entities/upload-version";
import versionDiff from "@/api/handlers/entities/version-diff";
import versionSummarize from "@/api/handlers/entities/version-summarize";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";
import {
  ENTITY_UPLOAD_ROUTE_PATHS,
  isTranslateRateLimitedPath,
  isUploadRateLimitedPath,
} from "@/api/lib/upload-rate-limit";

const entityRealtimeUpdates = workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY);
const entityFileRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.USER_FILE,
]);
const entityVersionRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.ENTITY_VERSION,
  RESOURCE_TYPE.USER_FILE,
]);

export const entitiesRoute = new Elysia({
  prefix: "/entities/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
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
    resourceSetUpdated: entityRealtimeUpdates,
    permissions: createEntities.config.permissions,
  })
  .put("/blank-document", createBlankDocument.handler, {
    body: createBlankDocument.config.body,
    resourceSetUpdated: entityFileRealtimeUpdates,
    permissions: createBlankDocument.config.permissions,
  })
  .put("/blank-document-from-style-set", createDocumentFromStyleSet.handler, {
    body: createDocumentFromStyleSet.config.body,
    resourceSetUpdated: entityFileRealtimeUpdates,
    permissions: createDocumentFromStyleSet.config.permissions,
  })
  .post(ENTITY_UPLOAD_ROUTE_PATHS.entity, uploadEntity.handler, {
    body: uploadEntity.config.body,
    resourceSetUpdated: entityFileRealtimeUpdates,
    permissions: uploadEntity.config.permissions,
  })
  .post(
    ENTITY_UPLOAD_ROUTE_PATHS.generatedDocument,
    uploadGeneratedDocument.handler,
    {
      body: uploadGeneratedDocument.config.body,
      resourceSetUpdated: entityFileRealtimeUpdates,
      permissions: uploadGeneratedDocument.config.permissions,
    },
  )
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
  .post("/folio-collab-rooms/join", joinFolioCollabRoom.handler, {
    body: joinFolioCollabRoom.config.body,
    permissions: joinFolioCollabRoom.config.permissions,
  })
  .post("/folio-collab-rooms/checkpoint", checkpointFolioCollabRoom.handler, {
    body: checkpointFolioCollabRoom.config.body,
    permissions: checkpointFolioCollabRoom.config.permissions,
  })
  .post(
    "/folio-collab-rooms/publish-version",
    publishFolioCollabVersion.handler,
    {
      body: publishFolioCollabVersion.config.body,
      permissions: publishFolioCollabVersion.config.permissions,
    },
  )
  .post("/desktop-edit-sessions/release", releaseDesktopEditLock.handler, {
    body: releaseDesktopEditLock.config.body,
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
    resourceSetUpdated: entityFileRealtimeUpdates,
  })
  .post("/create-from-legal-source", createFromLegalSource.handler, {
    body: createFromLegalSource.config.body,
    resourceSetUpdated: entityFileRealtimeUpdates,
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
  .post("/group-counts", readGroupCounts.handler, {
    body: readGroupCounts.config.body,
    permissions: readGroupCounts.config.permissions,
  })
  .post("/property-facets", readPropertyFacets.handler, {
    body: readPropertyFacets.config.body,
    permissions: readPropertyFacets.config.permissions,
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
    resourceSetUpdated: entityFileRealtimeUpdates,
    permissions: deleteEntities.config.permissions,
  })
  .patch("/move", moveEntity.handler, {
    body: moveEntity.config.body,
    resourceSetUpdated: entityRealtimeUpdates,
    permissions: moveEntity.config.permissions,
  })
  .patch("/rename", renameEntity.handler, {
    body: renameEntity.config.body,
    resourceSetUpdated: entityRealtimeUpdates,
    permissions: renameEntity.config.permissions,
  })
  .post("/duplicate", duplicateEntity.handler, {
    body: duplicateEntity.config.body,
    resourceSetUpdated: entityFileRealtimeUpdates,
    permissions: duplicateEntity.config.permissions,
  })
  .post("/copy-to-workspace", copyToWorkspace.handler, {
    body: copyToWorkspace.config.body,
    resourceSetUpdated: entityRealtimeUpdates,
    permissions: copyToWorkspace.config.permissions,
  })
  .post("/check-stamp", checkStamp.handler, {
    body: checkStamp.config.body,
    permissions: checkStamp.config.permissions,
  })
  .get("/summaries/count", readEntitySummariesCount.handler, {
    permissions: readEntitySummariesCount.config.permissions,
    query: readEntitySummariesCount.config.query,
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
    query: readVersions.config.query,
    permissions: readVersions.config.permissions,
  })
  .get("/entity/:entityId/versions/:versionId", readVersionById.handler, {
    params: readVersionById.config.params,
    permissions: readVersionById.config.permissions,
  })
  .get("/entity/:entityId/field/:fieldId/file", readFieldFile.handler, {
    params: readFieldFile.config.params,
    permissions: readFieldFile.config.permissions,
  })
  .post("/entity/:entityId/ocr", requestOcr.handler, {
    body: requestOcr.config.body,
    params: requestOcr.config.params,
    permissions: requestOcr.config.permissions,
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
      resourceSetUpdated: entityVersionRealtimeUpdates,
      params: updateVersionLabel.config.params,
      permissions: updateVersionLabel.config.permissions,
    },
  )
  .patch(
    "/entity/:entityId/versions/:versionId/description",
    updateVersionDescription.handler,
    {
      body: updateVersionDescription.config.body,
      resourceSetUpdated: entityVersionRealtimeUpdates,
      params: updateVersionDescription.config.params,
      permissions: updateVersionDescription.config.permissions,
    },
  )
  .post(
    "/entity/:entityId/versions/:versionId/restore",
    restoreVersion.handler,
    {
      params: restoreVersion.config.params,
      permissions: restoreVersion.config.permissions,
    },
  )
  .delete("/entity/:entityId/versions/:versionId", deleteVersion.handler, {
    params: deleteVersion.config.params,
    permissions: deleteVersion.config.permissions,
  })
  .post(ENTITY_UPLOAD_ROUTE_PATHS.version, uploadVersion.handler, {
    body: uploadVersion.config.body,
    resourceSetUpdated: entityVersionRealtimeUpdates,
    permissions: uploadVersion.config.permissions,
  })
  .post("/bilingual", createBilingualEntity.handler, {
    body: createBilingualEntity.config.body,
    resourceSetUpdated: entityFileRealtimeUpdates,
    permissions: createBilingualEntity.config.permissions,
  });
