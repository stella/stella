import { slugify as slugifyText } from "@stll/text-normalize";

// Authored skills don't ship with a pre-validated slug — derive one from the
// name so the rest of the skills surface (uniqueness, references) keeps working
// unchanged. Trim invalid chars, collapse runs of hyphens, and clip to fit the
// `slug` column.
export const slugify = (name: string): string =>
  slugifyText(name, {
    charset: "ascii",
    separator: "-",
    maxLength: 56,
    fallback: "skill",
  });

// Stable-ish suffix to break (org, scope, slug) collisions without requiring a
// server-side counter. Date-encoded so users can spot the authored-on
// timestamp at a glance in the URL.
export const collisionSuffix = (): string => Date.now().toString(36).slice(-7);

// Compose a unique slug from a display name, clipped to the slug column width.
export const uniqueSlug = (name: string): string =>
  `${slugify(name)}-${collisionSuffix()}`.slice(0, 64);
