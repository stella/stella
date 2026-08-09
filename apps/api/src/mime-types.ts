import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@stll/api-contract";

export const PDF_MIME_TYPE = "application/pdf" as const;
/** Required content type for binary endpoint responses consumed through the
 *  Eden treaty client: treaty only maps `application/octet-stream` to
 *  `arrayBuffer()` and text-decodes every other non-JSON content type, which
 *  UTF-8-mangles DOCX/PDF bytes beyond repair. The concrete type travels in
 *  the Content-Disposition filename and is reattached client-side. */
export const OCTET_STREAM_MIME_TYPE = "application/octet-stream" as const;
export const DOC_MIME_TYPE = "application/msword" as const;
export const DOCX_MIME_TYPE = DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType;
export const DOCM_MIME_TYPE =
  "application/vnd.ms-word.document.macroEnabled.12" as const;
export const XLS_MIME_TYPE = "application/vnd.ms-excel" as const;
export const XLSX_MIME_TYPE = DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.mimeType;
export const XLSB_MIME_TYPE =
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12" as const;
export const PPT_MIME_TYPE = "application/vnd.ms-powerpoint" as const;
export const PPTX_MIME_TYPE = DESKTOP_EDIT_FILE_TYPE_CONFIG.pptx.mimeType;
export const PPSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow" as const;
export const ODT_MIME_TYPE = "application/vnd.oasis.opendocument.text" as const;
export const ODS_MIME_TYPE =
  "application/vnd.oasis.opendocument.spreadsheet" as const;
export const ODP_MIME_TYPE =
  "application/vnd.oasis.opendocument.presentation" as const;
export const RTF_MIME_TYPE = "application/rtf" as const;
export const EPUB_MIME_TYPE = "application/epub+zip" as const;
