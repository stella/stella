import JSZip from "jszip";

/** Standard DOCX compression options */
export const DOCX_COMPRESSION = {
  type: "arraybuffer" as const,
  compression: "DEFLATE" as const,
  compressionOptions: { level: 6 },
};

/** Load a DOCX file (ArrayBuffer) into a JSZip instance */
export const loadDocx = async (buffer: ArrayBuffer): Promise<JSZip> =>
  await JSZip.loadAsync(buffer);

/** Extract a text file from a ZIP */
export const extractText = async (
  zip: JSZip,
  path: string,
): Promise<string | null> => {
  const file = zip.file(path);
  if (!file) {
    return null;
  }
  return await file.async("string");
};

/** Extract a binary file from a ZIP */
export const extractBinary = async (
  zip: JSZip,
  path: string,
): Promise<ArrayBuffer | null> => {
  const file = zip.file(path);
  if (!file) {
    return null;
  }
  return await file.async("arraybuffer");
};

/** Repack a ZIP to ArrayBuffer with standard DOCX compression */
export const repackZip = async (zip: JSZip): Promise<ArrayBuffer> =>
  await zip.generateAsync(DOCX_COMPRESSION);
