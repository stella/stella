/**
 * Content contract for a template pack: the shape of `packs/<id>/pack.json`
 * in the content repository mounted at `content/`, and the entry the
 * manifest generator derives from it. The generator validates every pack
 * against `packManifestSchema` so the generated manifest is typed from the
 * contract rather than trusted.
 */

import * as v from "valibot";

export const TEMPLATE_PACK_AUTHOR_ROLES = [
  "drafter",
  "reviewer",
  "converter",
] as const;
export type TemplatePackAuthorRole =
  (typeof TEMPLATE_PACK_AUTHOR_ROLES)[number];

/** Pack ids and template slugs: lowercase, digits, single hyphens. */
export const TEMPLATE_PACK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** ISO 3166-1 alpha-2, uppercase. */
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Pack-relative file path: no absolute roots, no parent traversal. */
const RELATIVE_PATH_PATTERN = /^[\w.-]+(?:\/[\w.-]+)*$/u;

const slugSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(TEMPLATE_PACK_SLUG_PATTERN),
);
const relativePathSchema = v.pipe(
  v.string(),
  v.maxLength(256),
  v.regex(RELATIVE_PATH_PATTERN),
  v.check((value) => !value.split("/").includes("..")),
);
const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const optionalString = v.optional(v.string());

export const templatePackJurisdictionSchema = v.strictObject({
  country: v.pipe(v.string(), v.regex(COUNTRY_PATTERN)),
  subdivision: optionalString,
});
export type TemplatePackJurisdiction = v.InferOutput<
  typeof templatePackJurisdictionSchema
>;

export const templatePackAuthorSchema = v.strictObject({
  name: nonEmptyString,
  organization: optionalString,
  url: optionalString,
  role: v.picklist(TEMPLATE_PACK_AUTHOR_ROLES),
  date: optionalString,
});
export type TemplatePackAuthor = v.InferOutput<typeof templatePackAuthorSchema>;

export const templatePackSourceSchema = v.strictObject({
  name: nonEmptyString,
  url: nonEmptyString,
  retrievedAt: optionalString,
});
export type TemplatePackSource = v.InferOutput<typeof templatePackSourceSchema>;

const templateEntrySchema = v.strictObject({
  slug: slugSchema,
  title: nonEmptyString,
  /** Path of the DOCX relative to the pack directory. */
  file: relativePathSchema,
  /** Path of the template README relative to the pack directory. */
  readme: relativePathSchema,
  jurisdictions: v.optional(v.array(templatePackJurisdictionSchema)),
  languages: v.optional(v.array(nonEmptyString)),
  legalArea: optionalString,
  license: optionalString,
});

/** `pack.json` as committed in the content repository. */
export const packManifestSchema = v.strictObject({
  id: slugSchema,
  name: nonEmptyString,
  version: nonEmptyString,
  description: v.optional(v.string(), ""),
  /** SPDX identifier. */
  license: nonEmptyString,
  licenseUrl: optionalString,
  source: v.optional(templatePackSourceSchema),
  authors: v.optional(v.array(templatePackAuthorSchema), []),
  /** Empty means jurisdiction-agnostic. */
  jurisdictions: v.optional(v.array(templatePackJurisdictionSchema), []),
  languages: v.optional(v.array(nonEmptyString), []),
  legalAreas: v.optional(v.array(nonEmptyString), []),
  lastReviewedAt: optionalString,
  disclaimer: optionalString,
  templates: v.array(templateEntrySchema),
});
export type PackManifest = v.InferOutput<typeof packManifestSchema>;

/** `index.json` at the content root: the complete generated catalogue shape. */
export const packIndexSchema = v.array(
  v.strictObject({
    id: slugSchema,
    name: nonEmptyString,
    version: nonEmptyString,
    license: nonEmptyString,
    jurisdictions: v.array(templatePackJurisdictionSchema),
    languages: v.array(nonEmptyString),
    legalAreas: v.array(nonEmptyString),
    authors: v.array(templatePackAuthorSchema),
    templateCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    templates: v.array(
      v.strictObject({
        slug: slugSchema,
        title: nonEmptyString,
        file: relativePathSchema,
        license: nonEmptyString,
        jurisdictions: v.array(templatePackJurisdictionSchema),
        languages: v.array(nonEmptyString),
        legalArea: v.nullable(nonEmptyString),
        fields: v.array(nonEmptyString),
        sha256: v.pipe(v.string(), v.regex(SHA256_PATTERN)),
      }),
    ),
  }),
);
export type PackIndexTemplate = v.InferOutput<
  typeof packIndexSchema
>[number]["templates"][number];

/** One template inside a generated pack entry. Jurisdictions, languages and
 *  license are effective values: the template's own when it sets them,
 *  otherwise the pack's. */
export type GeneratedTemplatePackTemplate = {
  slug: string;
  title: string;
  /** DOCX path relative to the pack directory. */
  file: string;
  /** README path relative to the pack directory. */
  readmeFile: string;
  jurisdictions: readonly TemplatePackJurisdiction[];
  languages: readonly string[];
  legalArea: string | null;
  license: string;
  /** Field paths listed by the content index; empty when the index is absent. */
  fields: readonly string[];
  /** SHA-256 of the DOCX bytes, lowercase hex. */
  sha256: string;
  /** Template README text. */
  readme: string;
};

/** One pack in the generated manifest: `pack.json` plus derived fields. */
export type GeneratedTemplatePack = {
  id: string;
  name: string;
  version: string;
  description: string;
  license: string;
  licenseUrl: string | null;
  source: TemplatePackSource | null;
  authors: readonly TemplatePackAuthor[];
  jurisdictions: readonly TemplatePackJurisdiction[];
  languages: readonly string[];
  legalAreas: readonly string[];
  lastReviewedAt: string | null;
  disclaimer: string | null;
  templates: readonly GeneratedTemplatePackTemplate[];
};
