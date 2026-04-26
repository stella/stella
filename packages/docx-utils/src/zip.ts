import JSZip from "jszip";

/** Standard DOCX compression options */
export const DOCX_COMPRESSION = {
  type: "arraybuffer" as const,
  compression: "DEFLATE" as const,
  compressionOptions: { level: 6 },
};

/** Load a DOCX file (ArrayBuffer) into a JSZip instance */
export const loadDocx = (buffer: ArrayBuffer): Promise<JSZip> =>
  JSZip.loadAsync(buffer);

/** Extract a text file from a ZIP */
export const extractText = (
  zip: JSZip,
  path: string,
): Promise<string | null> => {
  const file = zip.file(path);
  if (!file) {
    return Promise.resolve(null);
  }
  return file.async("string");
};

/** Extract a binary file from a ZIP */
export const extractBinary = (
  zip: JSZip,
  path: string,
): Promise<ArrayBuffer | null> => {
  const file = zip.file(path);
  if (!file) {
    return Promise.resolve(null);
  }
  return file.async("arraybuffer");
};

/** Repack a ZIP to ArrayBuffer with standard DOCX compression */
export const repackZip = (zip: JSZip): Promise<ArrayBuffer> =>
  zip.generateAsync(DOCX_COMPRESSION);
