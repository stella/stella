/**
 * Word-processing and spreadsheet formats stella reads by converting them to
 * PDF: the PDF is their preview, and the text read from it is what search,
 * chat, workflows and document reads see. They have no mark of their own, so
 * they show the generic file mark with their tag.
 *
 * `mimeAliases` are the other types clients declare for the same files (a
 * Mac names a Pages file `application/x-iwork-pages-sffpages`).
 * `converterExtension` is the name the converter must receive the file under:
 * it picks its importer by extension and accepts only that one. `zipPackage`
 * marks a format stored as a ZIP package, which clients may declare as a
 * plain ZIP archive.
 */
export const CONVERTED_DOCUMENT_FORMATS = [
  {
    label: "WPD",
    mimeType: "application/vnd.wordperfect",
    mimeAliases: [
      "application/wordperfect",
      "application/wordperfect5.1",
      "application/x-wordperfect",
    ],
    extensions: [".wpd", ".wp", ".wp5", ".wp6"],
    converterExtension: ".wpd",
    zipPackage: false,
  },
  {
    label: "WPS",
    mimeType: "application/vnd.ms-works",
    mimeAliases: [],
    extensions: [".wps"],
    converterExtension: ".wps",
    zipPackage: false,
  },
  {
    label: "PAGES",
    mimeType: "application/vnd.apple.pages",
    mimeAliases: ["application/x-iwork-pages-sffpages"],
    extensions: [".pages"],
    converterExtension: ".pages",
    zipPackage: true,
  },
  {
    label: "NUMBERS",
    mimeType: "application/vnd.apple.numbers",
    mimeAliases: ["application/x-iwork-numbers-sffnumbers"],
    extensions: [".numbers"],
    converterExtension: ".numbers",
    zipPackage: true,
  },
] as const;

export type ConvertedDocumentFormat =
  (typeof CONVERTED_DOCUMENT_FORMATS)[number];

/** Every media type, canonical or alias, a converted format is declared as. */
export type ConvertedDocumentMimeType =
  | ConvertedDocumentFormat["mimeType"]
  | ConvertedDocumentFormat["mimeAliases"][number];

/** The converted format declared by `mimeType` (canonical or alias), if any. */
export const convertedDocumentFormatOfMimeType = (
  mimeType: string,
): ConvertedDocumentFormat | undefined =>
  CONVERTED_DOCUMENT_FORMATS.find(
    (format) =>
      format.mimeType === mimeType ||
      format.mimeAliases.some((alias) => alias === mimeType),
  );

/** Whether `mimeType` declares a converted format, canonically or by alias. */
export const isConvertedDocumentMimeType = (
  mimeType: string,
): mimeType is ConvertedDocumentMimeType =>
  convertedDocumentFormatOfMimeType(mimeType) !== undefined;

/**
 * Formats whose preview is rendered from HTML stella builds out of them: a
 * web archive's page with its own images, an e-book's chapters in reading
 * order. That HTML converts like any other HTML file.
 */
export const HTML_RENDERED_DOCUMENT_FORMATS = [
  {
    label: "MHT",
    mimeType: "multipart/related",
    mimeAliases: ["application/x-mimearchive", "message/x-mht"],
    extensions: [".mht", ".mhtml"],
    zipPackage: false,
  },
  {
    label: "EPUB",
    mimeType: "application/epub+zip",
    mimeAliases: [],
    extensions: [".epub"],
    zipPackage: true,
  },
] as const;

export type HtmlRenderedDocumentFormat =
  (typeof HTML_RENDERED_DOCUMENT_FORMATS)[number];

/** Every media type, canonical or alias, an HTML-rendered format is declared as. */
export type HtmlRenderedDocumentMimeType =
  | HtmlRenderedDocumentFormat["mimeType"]
  | HtmlRenderedDocumentFormat["mimeAliases"][number];

/** The HTML-rendered format declared by `mimeType`, if any. */
export const htmlRenderedDocumentFormatOfMimeType = (
  mimeType: string,
): HtmlRenderedDocumentFormat | undefined =>
  HTML_RENDERED_DOCUMENT_FORMATS.find(
    (format) =>
      format.mimeType === mimeType ||
      format.mimeAliases.some((alias) => alias === mimeType),
  );

/** The converted or HTML-rendered format a file name's extension names. */
export const previewedDocumentFormatOfFileName = (
  fileName: string,
): ConvertedDocumentFormat | HtmlRenderedDocumentFormat | undefined => {
  const lower = fileName.trim().toLowerCase();
  return [
    ...CONVERTED_DOCUMENT_FORMATS,
    ...HTML_RENDERED_DOCUMENT_FORMATS,
  ].find((format) =>
    format.extensions.some((extension) => lower.endsWith(extension)),
  );
};
