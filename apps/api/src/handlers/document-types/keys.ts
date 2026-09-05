import { panic } from "better-result";

import { slugify } from "@stll/text-normalize";

// Derive the stable slug `key` from a label. `key` is what playbook scopes
// reference, so it is generated once on create and never changes on rename.
// The column takes 120 characters, and a label with no slug-able characters
// (e.g. non-Latin) still needs a key.
export const slugifyDocumentTypeKey = (label: string): string =>
  slugify(label, {
    charset: "ascii",
    separator: "-",
    maxLength: 120,
    fallback: "type",
  });

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
  return panic("unable to derive a unique document type key");
};
