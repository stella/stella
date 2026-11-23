import { panic } from "better-result";
import { inflateRawSync } from "node:zlib";

/** The ZIP record signatures a Word document's container uses. */
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
const CENTRAL_DIRECTORY_ENTRY = 0x02_01_4b_50;
const STORED = 0;
const DEFLATED = 8;

/**
 * The text of a Word document's body, read from its bytes: the
 * `word/document.xml` part with the markup stripped. Enough for a spec to
 * check which words a saved document carries.
 */
export const docxBodyText = (bytes: Uint8Array): string => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) {
    end -= 1;
  }
  if (end < 0) {
    panic("The bytes are not a ZIP container");
  }
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(at, true) !== CENTRAL_DIRECTORY_ENTRY) {
      panic("The ZIP central directory is damaged");
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeader = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLength),
    );
    if (name === "word/document.xml") {
      const dataStart =
        localHeader +
        30 +
        view.getUint16(localHeader + 26, true) +
        view.getUint16(localHeader + 28, true);
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method !== STORED && method !== DEFLATED) {
        panic(`Unsupported ZIP compression method ${method}`);
      }
      const xml = new TextDecoder().decode(
        method === DEFLATED ? inflateRawSync(data) : data,
      );
      return xml
        .replaceAll(/<\/w:p>/gu, "\n")
        .replaceAll(/<[^>]+>/gu, "")
        .replaceAll("&amp;", "&")
        .replaceAll("&apos;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">");
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  panic("The document has no word/document.xml part");
};
