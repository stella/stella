/** PK\x03\x04 — local file header signature. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

export const ZIP_BASED_MIMES: readonly string[] = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.ms-excel.template.macroEnabled.12",
  "application/vnd.ms-excel.addin.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.ms-powerpoint.template.macroEnabled.12",
  "application/vnd.ms-powerpoint.addin.macroEnabled.12",
  "application/zip",
  "application/x-zip-compressed",
];

export const hasZipMagic = (buffer: Uint8Array): boolean => {
  if (buffer.length < ZIP_MAGIC.length) {
    return false;
  }
  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (buffer[i] !== ZIP_MAGIC[i]) {
      return false;
    }
  }
  return true;
};
