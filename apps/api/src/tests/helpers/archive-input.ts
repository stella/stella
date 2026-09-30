import { panic } from "better-result";
import JSZip from "jszip";

export const archiveWithDeclaredSize = async (
  size: number,
): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", "<document/>", { createFolders: false });
  const buffer = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const payloadOffset =
    30 + view.getUint16(26, true) + view.getUint16(28, true);
  bytes[payloadOffset] = 0xff;
  for (let offset = payloadOffset; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) === 0x02_01_4b_50) {
      view.setUint32(offset + 24, size, true);
      return buffer;
    }
  }
  return panic("Expected an upstream ZIP central directory");
};
