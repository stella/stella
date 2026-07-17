import * as v from "valibot";

export const CATALOGUE_KINDS = ["skill", "mcp", "native-tool"] as const;
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];

/**
 * Cost = does money leave the user's wallet? BYOK counts as paid
 * since the vendor charges, not Stella.
 */
export const CATALOGUE_COST = ["free", "paid"] as const;
export type CatalogueCost = (typeof CATALOGUE_COST)[number];

/**
 * Setup = what does the user have to do before first use?
 *   - none: works out of the box
 *   - account: signup at the vendor required, no payment
 *   - api-key: user supplies an API key (BYOK)
 */
export const CATALOGUE_SETUP = ["none", "account", "api-key"] as const;
export type CatalogueSetup = (typeof CATALOGUE_SETUP)[number];

/**
 * SPDX identifiers we accept for catalogue entries. Permissive only;
 * copyleft (GPL, AGPL, etc.) is rejected so downstream redistribution
 * stays unconstrained for self-hosters and the in-tree-content
 * recommendation model holds.
 */
export const CATALOGUE_LICENSES = [
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
] as const;
export type CatalogueLicense = (typeof CATALOGUE_LICENSES)[number];

/**
 * Compare untrusted upstream SPDX identifiers with the reviewed canonical
 * catalogue spelling. Upstream frontmatter is allowed to vary only in ASCII
 * case and surrounding whitespace; persisted values still come from the
 * catalogue manifest.
 */
export const catalogueLicensesMatch = ({
  catalogueLicense,
  upstreamLicense,
}: {
  catalogueLicense: CatalogueLicense;
  upstreamLicense: string | null | undefined;
}): boolean =>
  upstreamLicense?.trim().toLowerCase() === catalogueLicense.toLowerCase();

export const MCP_AUTH_TYPES = ["none", "bearer", "oauth"] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];

/**
 * Generic practice areas. Picklist (not freeform) so the catalogue
 * surfaces a consistent taxonomy across jurisdictions — a corporate
 * tool from Czechia uses the same `corporate` tag as one from Japan.
 * Reasonably international: covers the practice groupings most
 * mid-size to large firms organise around.
 */
export const PRACTICE_AREAS = [
  "banking-finance",
  "capital-markets",
  "commercial",
  "competition",
  "corporate",
  "criminal",
  "data-protection",
  "dispute-resolution",
  "employment",
  "energy",
  "environmental",
  "family",
  "immigration",
  "insolvency",
  "intellectual-property",
  "litigation",
  "mergers-acquisitions",
  "private-client",
  "public-administrative",
  "real-estate",
  "regulatory",
  "tax",
  "technology",
  "white-collar-crime",
] as const;
export type PracticeArea = (typeof PRACTICE_AREAS)[number];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ISO_COUNTRY_OR_UNION = /^[A-Z]{2}$/u;

/**
 * Max slug length. Exported so the contribute form's slug derivation
 * caps to the same limit the schema enforces (single source of truth).
 */
export const MAX_SLUG_LENGTH = 64;

const slug = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(MAX_SLUG_LENGTH),
  v.regex(SLUG_PATTERN, "slug must be kebab-case"),
);

/**
 * GitHub `owner/name`. Owner: 1–39 chars, alphanumeric or hyphen, no
 * leading hyphen. Name: 1–100 chars from GitHub's allowed set. Storing
 * the bare identifier (not a URL) makes "GitHub only" structural — the
 * URL builders in the loader are the sole way it becomes a URL. Named
 * `owner`/`name` groups let the contribute form's normalizer reuse this
 * one pattern instead of re-declaring its own copy.
 */
export const GITHUB_REPO_PATTERN =
  /^(?<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})\/(?<name>[A-Za-z0-9._-]{1,100})$/u;
/** Full 40-character lowercase hex commit SHA; abbreviated refs rejected. */
export const GITHUB_REV_PATTERN = /^[0-9a-f]{40}$/u;
/** Relative path segments; dot segments rejected by an extra check. */
const GITHUB_DIRECTORY_PATTERN = /^[\w.-]+(?:\/[\w.-]+)*$/u;

const githubRepo = v.pipe(
  v.string(),
  v.regex(GITHUB_REPO_PATTERN, "repo must be a GitHub 'owner/name' identifier"),
);

const githubRev = v.pipe(
  v.string(),
  v.regex(
    GITHUB_REV_PATTERN,
    "rev must be a full 40-character lowercase hex commit SHA",
  ),
);

/**
 * Location of the skill directory inside the upstream repo; the entry
 * file is `SKILL.md` inside it, and it defaults to the repo root when
 * omitted. Deliberately the only locator knob for github skills: no
 * per-file entryPath and no resource list, since content is fetched
 * from the pinned tree rather than mirrored into this repo.
 */
const githubDirectory = v.pipe(
  v.string(),
  v.minLength(1),
  v.regex(
    GITHUB_DIRECTORY_PATTERN,
    "directory must be a relative path within the repo",
  ),
  v.check(
    (value) =>
      value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "directory must not contain '.' or '..' segments",
  ),
);

const jurisdiction = v.pipe(
  v.string(),
  v.regex(
    ISO_COUNTRY_OR_UNION,
    "jurisdiction must be a 2-letter uppercase code",
  ),
);

const commonFields = {
  $schema: v.optional(v.string()),
  slug,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  author: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  authorUrl: v.optional(v.pipe(v.string(), v.url())),
  license: v.picklist(CATALOGUE_LICENSES),
  cost: v.picklist(CATALOGUE_COST),
  setup: v.picklist(CATALOGUE_SETUP),
  homepage: v.optional(v.pipe(v.string(), v.url())),
  iconUrl: v.optional(v.pipe(v.string(), v.url())),
  /**
   * Practice areas the entry is relevant for. Picklist enforces a
   * consistent taxonomy — see PRACTICE_AREAS for the allowed values.
   */
  tags: v.optional(v.array(v.picklist(PRACTICE_AREAS)), []),
  jurisdictions: v.optional(v.array(jurisdiction), []),
};

/**
 * Skill whose content lives in this repo next to the manifest. Subject
 * to the 10 MB per-entry cap and entryPath/resource existence checks.
 */
export const inTreeSkillEntrySchema = v.strictObject({
  kind: v.literal("skill"),
  source: v.literal("in-tree"),
  ...commonFields,
  entryPath: v.pipe(v.string(), v.minLength(1)),
  resources: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), []),
});

/**
 * Skill whose content stays upstream on GitHub, pinned to an immutable
 * commit SHA. No content enters this repo, so the size cap does not
 * apply; curation still endorses specific bytes because `rev` is fixed.
 */
export const githubSkillEntrySchema = v.strictObject({
  kind: v.literal("skill"),
  source: v.literal("github"),
  ...commonFields,
  repo: githubRepo,
  rev: githubRev,
  directory: v.optional(githubDirectory),
});

export const skillEntrySchema = v.variant("source", [
  inTreeSkillEntrySchema,
  githubSkillEntrySchema,
]);

export const mcpEntrySchema = v.strictObject({
  kind: v.literal("mcp"),
  ...commonFields,
  url: v.pipe(v.string(), v.url()),
  authType: v.picklist(MCP_AUTH_TYPES),
  oauthRequestedScopes: v.optional(v.array(v.string()), []),
  allowedTools: v.optional(v.array(v.string()), []),
  documentationUrl: v.optional(v.pipe(v.string(), v.url())),
  tokenHelpUrl: v.optional(v.pipe(v.string(), v.url())),
});

export const nativeToolEntrySchema = v.strictObject({
  kind: v.literal("native-tool"),
  ...commonFields,
  backendSlug: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(80),
    v.regex(SLUG_PATTERN, "backendSlug must be kebab-case"),
  ),
  /**
   * Always-on system capability — cannot be toggled or uninstalled.
   * Appears in the "Baseline" UI section above the recommended pack.
   * Use sparingly; reserved for capabilities the product treats as
   * non-optional (currently: web search, anonymise, create-docx).
   */
  pinned: v.optional(v.boolean(), false),
  url: v.optional(v.pipe(v.string(), v.url())),
  documentationUrl: v.optional(v.pipe(v.string(), v.url())),
});

export const catalogueEntrySchema = v.variant("kind", [
  skillEntrySchema,
  mcpEntrySchema,
  nativeToolEntrySchema,
]);

export type CatalogueEntry = v.InferOutput<typeof catalogueEntrySchema>;
export type SkillEntry = v.InferOutput<typeof skillEntrySchema>;
export type InTreeSkillEntry = v.InferOutput<typeof inTreeSkillEntrySchema>;
export type GithubSkillEntry = v.InferOutput<typeof githubSkillEntrySchema>;
export type McpEntry = v.InferOutput<typeof mcpEntrySchema>;
export type NativeToolEntry = v.InferOutput<typeof nativeToolEntrySchema>;

export const recommendedSchema = v.record(jurisdiction, v.array(slug));
export type Recommended = v.InferOutput<typeof recommendedSchema>;
