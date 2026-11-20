import asicPreviewEndpoint from "@/api/handlers/files/asic";
import {
  cadesContentEndpoint,
  cadesPreviewEndpoint,
} from "@/api/handlers/files/cades";
import dataBoxEndpoint from "@/api/handlers/files/data-box";
import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import saveEmailAttachmentEndpoint from "@/api/handlers/files/email-attachment/create";
import officeCitationEndpoint from "@/api/handlers/files/office-citation";
import { readFileContentEndpoint } from "@/api/handlers/files/read-content";
import {
  markedDownloadEndpoint,
  ocrExportEndpoint,
  printPdfEndpoint,
  readDocumentPropertiesEndpoint,
  readEmailHtmlPreviewEndpoint,
  readFileEndpoint,
  scrubbedDownloadEndpoint,
  stampedDownloadEndpoint,
  updateDocumentPropertiesEndpoint,
} from "@/api/handlers/files/routes";
import structuredDocumentPreviewEndpoint from "@/api/handlers/files/structured-document";
import readFileThumbnailEndpoint from "@/api/handlers/files/thumbnail";
import { routes } from "@/api/http/route";

export const filesRoute = routes(
  {
    "/url/:fieldId": { GET: readFileEndpoint },
    "/structured-document/:fieldId": { GET: structuredDocumentPreviewEndpoint },
    "/asic/:fieldId": { GET: asicPreviewEndpoint },
    "/cades/:fieldId": { GET: cadesPreviewEndpoint },
    "/cades/:fieldId/content": { GET: cadesContentEndpoint },
    "/data-box/:fieldId": { GET: dataBoxEndpoint },
    "/email-html/:fieldId": { GET: readEmailHtmlPreviewEndpoint },
    "/office-citation/:entityId/:fieldId/:blockId": {
      GET: officeCitationEndpoint,
    },
    "/print-pdf/:fieldId": { GET: printPdfEndpoint },
    "/stamped/:fieldId": { GET: stampedDownloadEndpoint },
    "/ocr-export/:fieldId": { GET: ocrExportEndpoint },
    "/document-properties/:fieldId": {
      GET: readDocumentPropertiesEndpoint,
      PATCH: updateDocumentPropertiesEndpoint,
    },
    "/scrubbed/:fieldId": { GET: scrubbedDownloadEndpoint },
    "/marked/:fieldId": { GET: markedDownloadEndpoint },
    "/thumbnail/:fieldId": { GET: readFileThumbnailEndpoint },
    "/email-attachment/:fieldId/:attachmentId": {
      GET: emailAttachmentEndpoint,
    },
    "/email-attachment/:fieldId/:attachmentId/save": {
      POST: saveEmailAttachmentEndpoint,
    },
  },
  { prefix: "/files/:workspaceId" },
);

// A short-lived grant names the file; no workspace prefix or session applies.
export const fileContentRoute = routes(
  { "/:grant": { GET: readFileContentEndpoint } },
  { prefix: "/file-content" },
);
