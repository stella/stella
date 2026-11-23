import asicPreviewEndpoint from "@/api/handlers/files/asic";
import { cadesPreviewEndpoint } from "@/api/handlers/files/cades";
import dataBoxEndpoint from "@/api/handlers/files/data-box";
import { eInvoicePreviewEndpoint } from "@/api/handlers/files/e-invoice";
import emailReadingEndpoint from "@/api/handlers/files/email-reading";
import officeCitationEndpoint from "@/api/handlers/files/office-citation";
import { readFilePartListEndpoint } from "@/api/handlers/files/part-list";
import saveFilePartEndpoint from "@/api/handlers/files/part-save";
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
import { signedDossierPreviewEndpoint } from "@/api/handlers/files/signed-dossier";
import structuredDocumentPreviewEndpoint from "@/api/handlers/files/structured-document";
import readFileThumbnailEndpoint from "@/api/handlers/files/thumbnail";
import { zipArchivePreviewEndpoint } from "@/api/handlers/files/zip-archive";
import { routes } from "@/api/http/route";

export const filesRoute = routes(
  {
    "/url/:fieldId": { GET: readFileEndpoint },
    "/structured-document/:fieldId": { GET: structuredDocumentPreviewEndpoint },
    "/e-invoice/:fieldId": { GET: eInvoicePreviewEndpoint },
    "/asic/:fieldId": { GET: asicPreviewEndpoint },
    "/zip/:fieldId": { GET: zipArchivePreviewEndpoint },
    "/cades/:fieldId": { GET: cadesPreviewEndpoint },
    "/signed-dossier/:fieldId": { GET: signedDossierPreviewEndpoint },
    "/data-box/:fieldId": { GET: dataBoxEndpoint },
    "/email-reading/:fieldId": { GET: emailReadingEndpoint },
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
    "/part/:fieldId/save": { POST: saveFilePartEndpoint },
    "/parts/:fieldId": { GET: readFilePartListEndpoint },
  },
  { prefix: "/files/:workspaceId" },
);

// A short-lived grant names the file; no workspace prefix or session applies.
export const fileContentRoute = routes(
  { "/:grant": { GET: readFileContentEndpoint } },
  { prefix: "/file-content" },
);
