/**
 * The copies of a stored file a download can hand over besides the plain
 * Download, in the order the app offers them. Where the plain Download is a
 * PDF with the reader's highlights written in, `original` is the upload as
 * stored and `withComments` the PDF with comments and author names as well.
 * `reference` is a DOCX with its document reference written into the body,
 * `pdf` the stored PDF conversion, `scrubbed` a copy without its embedded
 * metadata.
 */
export const FILE_DOWNLOAD_RENDITIONS = [
  "original",
  "withComments",
  "reference",
  "pdf",
  "scrubbed",
] as const;

export type FileDownloadRendition = (typeof FILE_DOWNLOAD_RENDITIONS)[number];
