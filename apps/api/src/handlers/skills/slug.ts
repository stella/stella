// Authored skills don't ship with a pre-validated slug — derive one from the
// name so the rest of the skills surface (uniqueness, references) keeps working
// unchanged. Trim invalid chars, collapse runs of hyphens, and clip to fit the
// `slug` column.
export const slugify = (name: string): string => {
  // Plain character-by-character pass — a regex pipeline tripped the slow-regex
  // lint, and a single-pass loop is also easier to reason about. Collapse runs
  // of non-slug chars into a single hyphen, then trim leading/trailing hyphens.
  let buffer = "";
  let lastWasSeparator = true;
  for (const ch of name.toLowerCase()) {
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
  // Clip first, then trim trailing hyphens — slicing after trimming could
  // re-introduce a trailing hyphen if the 56th char is one.
  let clipped = buffer.slice(0, 56);
  while (clipped.endsWith("-")) {
    clipped = clipped.slice(0, -1);
  }
  if (clipped.length === 0) {
    return "skill";
  }
  return clipped;
};

// Stable-ish suffix to break (org, scope, slug) collisions without requiring a
// server-side counter. Date-encoded so users can spot the authored-on
// timestamp at a glance in the URL.
export const collisionSuffix = (): string => Date.now().toString(36).slice(-7);

// Compose a unique slug from a display name, clipped to the slug column width.
export const uniqueSlug = (name: string): string =>
  `${slugify(name)}-${collisionSuffix()}`.slice(0, 64);
