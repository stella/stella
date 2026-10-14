/** The single way to write an entry into a JSZip archive. */
import type JSZip from "jszip";

/** Text or bytes to store as one archive entry. */
export type ZipEntryContent = string | Uint8Array | ArrayBuffer;

const utf8 = new TextEncoder();

/**
 * Write `content` to `path` in `zip`. Text is UTF-8 encoded here, in one
 * pass over the whole string, before JSZip sees it: JSZip encodes string
 * input in 16 KiB pieces, which splits a surrogate pair that straddles a
 * piece boundary into two U+FFFD characters.
 */
export const writeZipEntry = (
  zip: JSZip,
  path: string,
  content: ZipEntryContent,
  options?: JSZip.JSZipFileOptions,
): void => {
  const data = typeof content === "string" ? utf8.encode(content) : content;
  zip.file(path, data, options);
};
