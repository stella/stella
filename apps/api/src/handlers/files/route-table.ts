import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import saveEmailAttachmentEndpoint from "@/api/handlers/files/email-attachment/create";
import officeCitationEndpoint from "@/api/handlers/files/office-citation";
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
import readFileThumbnailEndpoint from "@/api/handlers/files/thumbnail";
import { routes } from "@/api/http/route";

export const filesRoute = routes(
  {
    "/url/:fieldId": { GET: readFileEndpoint },
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
