/**
 * Word-processing and spreadsheet formats stella reads by converting them to
 * PDF: the PDF is their preview, and the text read from it is what search,
 * chat, workflows and document reads see. They have no mark of their own, so
 * they show the generic file mark with their tag.
 *
 * `mimeAliases` are the other types clients declare for the same files (a
 * Mac names a Pages file `application/x-iwork-pages-sffpages`).
 * `converterExtension` is the name the converter must receive the file under:
 * it picks its importer by extension and accepts only that one.
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
  },
  {
    label: "WPS",
    mimeType: "application/vnd.ms-works",
    mimeAliases: [],
    extensions: [".wps"],
    converterExtension: ".wps",
  },
  {
    label: "PAGES",
    mimeType: "application/vnd.apple.pages",
    mimeAliases: ["application/x-iwork-pages-sffpages"],
    extensions: [".pages"],
    converterExtension: ".pages",
  },
  {
    label: "NUMBERS",
    mimeType: "application/vnd.apple.numbers",
    mimeAliases: ["application/x-iwork-numbers-sffnumbers"],
    extensions: [".numbers"],
    converterExtension: ".numbers",
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

/** The converted format a file name's extension names, if any. */
export const convertedDocumentFormatOfFileName = (
  fileName: string,
): ConvertedDocumentFormat | undefined => {
  const lower = fileName.trim().toLowerCase();
  return CONVERTED_DOCUMENT_FORMATS.find((format) =>
    format.extensions.some((extension) => lower.endsWith(extension)),
  );
};
