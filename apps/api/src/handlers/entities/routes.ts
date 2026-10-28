import createDocumentAnnotation from "@/api/handlers/entities/annotations/create";
import deleteDocumentAnnotation from "@/api/handlers/entities/annotations/delete";
import listDocumentAnnotations from "@/api/handlers/entities/annotations/list";
import updateDocumentAnnotation from "@/api/handlers/entities/annotations/update";
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
import { mount, routes } from "@/api/http/route";
import {
  translateBudget,
  uploadBudget,
} from "@/api/lib/rate-limit/dedicated-budgets";

const uploads = routes(
  {
    "/upload": { POST: uploadEntity },
    "/upload-generated-document": { POST: uploadGeneratedDocument },
    "/upload-version": { POST: uploadVersion },
  },
  { middleware: [uploadBudget] },
);

const bilingual = routes(
  { "/bilingual": { POST: createBilingualEntity } },
  { middleware: [translateBudget] },
);

const entities = routes({
  "/": { PUT: createEntities, DELETE: deleteEntities },
  "/blank-document": { PUT: createBlankDocument },
  "/blank-document-from-style-set": { PUT: createDocumentFromStyleSet },
  "/desktop-edit-sessions/open": { POST: openDesktopEditSession },
  "/desktop-edit-sessions/release": { POST: releaseDesktopEditLock },
  "/desktop-edit-sessions/request-takeover": {
    POST: requestDesktopEditTakeover,
  },
  "/desktop-edit-handoffs": { POST: createDesktopEditHandoff },
  "/desktop-edit-handoffs/:handoffId/status": {
    GET: readDesktopEditHandoffStatus,
  },
  "/pdf-signing-handoffs": { POST: createPdfSigningHandoff },
  "/pdf-signing-sessions/:sessionId": { GET: readPdfSigningSessionStatus },
  "/pdf-signing-sessions/:sessionId/cancel": { POST: cancelPdfSigningSession },
  "/folio-collab-rooms/join": { POST: joinFolioCollabRoom },
  "/folio-collab-rooms/checkpoint": { POST: checkpointFolioCollabRoom },
  "/folio-collab-rooms/publish-version": { POST: publishFolioCollabVersion },
  "/clip": { POST: clipEndpoint },
  "/create-from-legal-source": { POST: createFromLegalSource },
  "/query": { POST: readEntities },
  "/query-window": { POST: readEntitiesWindow },
  "/filesystem-tree": { POST: readFilesystemTree },
  "/kanban-group": { POST: readKanbanGroup },
  "/group-counts": { POST: readGroupCounts },
  "/property-facets": { POST: readPropertyFacets },
  "/organize-suggestions": { POST: organizeSuggestions },
  "/folders": { GET: listFolders },
  "/files": { GET: listFiles },
  "/move": { PATCH: moveEntity },
  "/folder-from-selection": { POST: createFolderFromSelection },
  "/rename": { PATCH: renameEntity },
  "/duplicate": { POST: duplicateEntity },
  "/copy-to-workspace": { POST: copyToWorkspace },
  "/check-stamp": { POST: checkStamp },
  "/summaries/count": { GET: readEntitySummariesCount },
  "/summaries": { GET: readEntitySummaries },
  "/zip/:entityId": { GET: downloadZip },
  "/entity/:entityId": { GET: readEntityById },
  "/entity/:entityId/versions": { GET: readVersions },
  "/entity/:entityId/versions/:versionId": {
    GET: readVersionById,
    DELETE: deleteVersion,
  },
  "/entity/:entityId/field/:fieldId/file": { GET: readFieldFile },
  "/entity/:entityId/field/:fieldId/annotations": {
    GET: listDocumentAnnotations,
    POST: createDocumentAnnotation,
  },
  "/entity/:entityId/annotations/:annotationId": {
    PATCH: updateDocumentAnnotation,
    DELETE: deleteDocumentAnnotation,
  },
  "/entity/:entityId/ocr": { POST: requestOcr },
  "/entity/:entityId/versions/:versionId/diff": { GET: versionDiff },
  "/entity/:entityId/versions/:versionId/summarize": {
    POST: versionSummarize,
  },
  "/entity/:entityId/versions/:versionId/label": { PATCH: updateVersionLabel },
  "/entity/:entityId/versions/:versionId/description": {
    PATCH: updateVersionDescription,
  },
  "/entity/:entityId/versions/:versionId/restore": { POST: restoreVersion },
});

export const entitiesRoute = mount([uploads, bilingual, entities], {
  prefix: "/entities/:workspaceId",
});
