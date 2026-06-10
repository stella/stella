export const PDF_MIME_TYPE = "application/pdf" as const;
/** Required content type for binary endpoint responses consumed through the
 *  Eden treaty client: treaty only maps `application/octet-stream` to
 *  `arrayBuffer()` and text-decodes every other non-JSON content type, which
 *  UTF-8-mangles DOCX/PDF bytes beyond repair. The concrete type travels in
 *  the Content-Disposition filename and is reattached client-side. */
export const OCTET_STREAM_MIME_TYPE = "application/octet-stream" as const;
export const DOC_MIME_TYPE = "application/msword" as const;
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
