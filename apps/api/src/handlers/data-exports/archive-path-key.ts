import { normalizeUnicode } from "@stll/text-normalize";

/** Identity shared by allocation and ZIP validation on case-insensitive filesystems. */
export const archivePathKey = (path: string): string =>
  normalizeUnicode(path, "NFC").toUpperCase().toLowerCase();
