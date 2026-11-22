import asicPreviewEndpoint from "@/api/handlers/files/asic";
import { cadesPreviewEndpoint } from "@/api/handlers/files/cades";
import certifiedEmailEndpoint from "@/api/handlers/files/certified-email";
import dataBoxEndpoint from "@/api/handlers/files/data-box";
import { eInvoicePreviewEndpoint } from "@/api/handlers/files/e-invoice";
import officeCitationEndpoint from "@/api/handlers/files/office-citation";
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
import { routes } from "@/api/http/route";

export const filesRoute = routes(
  {
    "/url/:fieldId": { GET: readFileEndpoint },
    "/structured-document/:fieldId": { GET: structuredDocumentPreviewEndpoint },
    "/e-invoice/:fieldId": { GET: eInvoicePreviewEndpoint },
    "/asic/:fieldId": { GET: asicPreviewEndpoint },
    "/cades/:fieldId": { GET: cadesPreviewEndpoint },
    "/signed-dossier/:fieldId": { GET: signedDossierPreviewEndpoint },
    "/data-box/:fieldId": { GET: dataBoxEndpoint },
    "/certified-email/:fieldId": { GET: certifiedEmailEndpoint },
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
  },
  { prefix: "/files/:workspaceId" },
);

// A short-lived grant names the file; no workspace prefix or session applies.
export const fileContentRoute = routes(
  { "/:grant": { GET: readFileContentEndpoint } },
  { prefix: "/file-content" },
);
