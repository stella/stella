import { normalizeUnicode } from "@stll/text-normalize";

/**
 * Conservative filesystem identity shared by allocation and ZIP validation.
 * Iterate NFC and upper/lower casing to a fixed point, then return NFC.
 * Over-merging only adds a collision suffix; under-merging can overwrite a
 * file on extraction. Stored path spelling is unchanged.
 */
export const archivePathKey = (path: string): string => {
  let key = path;
  for (;;) {
    const next = normalizeUnicode(key, "NFC").toUpperCase().toLowerCase();
    if (next === key) {
      return normalizeUnicode(next, "NFC");
    }
    key = next;
  }
};
