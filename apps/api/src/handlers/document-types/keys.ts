import { panic } from "better-result";

// Derive the stable slug `key` from a label. `key` is what playbook scopes
// reference, so it is generated once on create and never changes on rename.
// Single-pass (a regex pipeline trips the slow-regex lint): keep [a-z0-9],
// collapse every other run into one hyphen, trim, clip to the column width.
export const slugifyDocumentTypeKey = (label: string): string => {
  let buffer = "";
  let lastWasSeparator = true;
  for (const ch of label.toLowerCase()) {
    const isSlugChar = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (isSlugChar) {
      buffer += ch;
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator) {
      buffer += "-";
      lastWasSeparator = true;
    }
  }
  let clipped = buffer.slice(0, 120);
  while (clipped.endsWith("-")) {
    clipped = clipped.slice(0, -1);
  }
  // A label with no slug-able characters (e.g. non-Latin) still needs a key.
  return clipped.length === 0 ? "type" : clipped;
};

// Disambiguate against the org's existing keys by suffixing `-2`, `-3`, ....
// Bounded by the number of taken keys (pigeonhole: among base-2..base-(n+2)
// at least one is free), so the loop always resolves.
export const uniqueDocumentTypeKey = (
  base: string,
  taken: ReadonlySet<string>,
): string => {
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix <= taken.size + 2; suffix++) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  panic("unable to derive a unique document type key");
};
