/** ZIP-based office formats; legacy binary formats are not XML containers. */
export const OFFICE_ARCHIVE_FORMATS = {
  docx: {
    family: "word",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  docm: {
    family: "word",
    mimeType: "application/vnd.ms-word.document.macroEnabled.12",
  },
  dotx: {
    family: "word",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  },
  dotm: {
    family: "word",
    mimeType: "application/vnd.ms-word.template.macroEnabled.12",
  },
  xlsx: {
    family: "sheet",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  xlsm: {
    family: "sheet",
    mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
  },
  xlsb: {
    family: "sheet",
    mimeType: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  },
  xltx: {
    family: "sheet",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  },
  xltm: {
    family: "sheet",
    mimeType: "application/vnd.ms-excel.template.macroEnabled.12",
  },
  pptx: {
    family: "presentation",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  pptm: {
    family: "presentation",
    mimeType: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  },
  ppsx: {
    family: "presentation",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  },
  ppsm: {
    family: "presentation",
    mimeType: "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  },
  potx: {
    family: "presentation",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.template",
  },
  potm: {
    family: "presentation",
    mimeType: "application/vnd.ms-powerpoint.template.macroEnabled.12",
  },
  odt: { family: "odf", mimeType: "application/vnd.oasis.opendocument.text" },
  ods: {
    family: "odf",
    mimeType: "application/vnd.oasis.opendocument.spreadsheet",
  },
  odp: {
    family: "odf",
    mimeType: "application/vnd.oasis.opendocument.presentation",
  },
  ott: {
    family: "odf",
    mimeType: "application/vnd.oasis.opendocument.text-template",
  },
  ots: {
    family: "odf",
    mimeType: "application/vnd.oasis.opendocument.spreadsheet-template",
  },
  otp: {
    family: "odf",
    mimeType: "application/vnd.oasis.opendocument.presentation-template",
  },
} as const;
