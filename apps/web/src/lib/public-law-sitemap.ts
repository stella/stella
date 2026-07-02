import * as v from "valibot";

import { env } from "@/env";
import { apiUrl } from "@/lib/api-url";
import {
  type CaseLawLanguageAlternateLink,
  createCaseLawLanguageAlternateLinks,
} from "@/lib/case-law-language-alternates";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@/lib/case-law-route";
import { ClientOperationError } from "@/lib/errors/client";
import {
  isPublicLawCrawlAllowed,
  isPublicLawSitemapEnabled,
} from "@/lib/public-law-launch";
import { createPublicLawCanonicalUrl } from "@/lib/public-law-seo";
import {
  isPublicToolsCrawlAllowed,
  isPublicToolsSitemapEnabled,
} from "@/lib/public-tools-launch";

const LAW_SITEMAP_PATH = "/sitemaps/law.xml";
const LAW_CASES_SITEMAP_BASE_PATH = "/sitemaps/law-cases";
const SITEMAP_XML_MAX_BYTES = 50 * 1024 * 1024;
const SITEMAP_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400";

type FetchLike = (
  input: Request | URL | string,
  init?: RequestInit,
) => Promise<Response>;

const sitemapDecisionSchema = v.strictObject({
  id: v.string(),
  caseNumber: v.string(),
  slug: v.nullable(v.string()),
  country: v.string(),
  court: v.string(),
  language: v.string(),
  languageAlternates: v.array(
    v.strictObject({
      id: v.string(),
      caseNumber: v.string(),
      slug: v.nullable(v.string()),
      country: v.string(),
      court: v.string(),
      language: v.string(),
      updatedAt: v.string(),
    }),
  ),
  updatedAt: v.string(),
});

const sitemapShardSchema = v.strictObject({
  bucket: v.string(),
  country: v.string(),
  lastmod: v.nullable(v.string()),
  month: v.string(),
  year: v.string(),
});

const sitemapDecisionPageSchema = v.strictObject({
  items: v.array(sitemapDecisionSchema),
  limit: v.number(),
  nextCursor: v.nullable(v.string()),
});

const sitemapShardPageSchema = v.strictObject({
  items: v.array(sitemapShardSchema),
  limit: v.number(),
  nextCursor: v.nullable(v.string()),
});

type SitemapDecision = v.InferOutput<typeof sitemapDecisionSchema>;
type SitemapShard = v.InferOutput<typeof sitemapShardSchema>;
type SitemapDecisionUrlInput = Omit<SitemapDecision, "languageAlternates"> & {
  languageAlternates?: readonly unknown[];
};

type FetchSitemapDecisionsOptions = {
  fetchImpl?: FetchLike;
  shard: SitemapShardRouteParams;
  signal?: AbortSignal;
};

type FetchSitemapShardsOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

type PublicLawSitemapIndexOptions = {
  maxBytes?: number;
  publicLawIndexingEnabled?: boolean;
  publicToolsIndexingEnabled?: boolean;
};

// Kept as a literal (not imported from public-tools-sitemap) to avoid an
// import cycle: the tools sitemap module reuses this module's helpers.
const TOOLS_SITEMAP_PATH = "/sitemaps/tools.xml";

type PublicLawIndexingOptions = {
  publicLawIndexingEnabled?: boolean;
};

export type SitemapShardRouteParams = {
  bucket: string;
  country: string;
  month: string;
  year: string;
};

export const SITEMAP_XML_RESPONSE_HEADERS = {
  "Cache-Control": SITEMAP_CACHE_CONTROL,
  "Content-Type": "application/xml; charset=utf-8",
} as const;

const xmlEscape = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");

export const assertPublicLawSitemapXmlWithinProtocolLimits = (
  xml: string,
  maxBytes = SITEMAP_XML_MAX_BYTES,
): void => {
  const byteLength = new TextEncoder().encode(xml).byteLength;
  if (byteLength <= maxBytes) {
    return;
  }

  throw new ClientOperationError({
    action: "serializePublicCaseLawSitemap",
    message: `Public case-law sitemap exceeded ${maxBytes} bytes.`,
  });
};

const createCaseLawDecisionSitemapUrl = (
  decision: SitemapDecisionUrlInput,
): string => {
  const params = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

  return createPublicLawCanonicalUrl(createCaseLawDecisionPath(params));
};

const createCaseLawDecisionSitemapAlternateLinks = (
  decision: SitemapDecision,
): CaseLawLanguageAlternateLink[] =>
  createCaseLawLanguageAlternateLinks({
    alternates: decision.languageAlternates,
    createHref: (alternate) =>
      createCaseLawDecisionSitemapUrl({
        ...alternate,
        languageAlternates: decision.languageAlternates,
      }),
  });

const createCaseLawShardPath = ({
  bucket,
  country,
  month,
  year,
}: SitemapShardRouteParams): `/${string}` => {
  if (bucket === "all") {
    return `${LAW_CASES_SITEMAP_BASE_PATH}/${country}/${year}/${month}.xml`;
  }

  return `${LAW_CASES_SITEMAP_BASE_PATH}/${country}/${year}/${month}/${bucket}.xml`;
};

export const fetchPublicSitemapShards = async ({
  fetchImpl = fetch,
  signal = AbortSignal.timeout(10_000),
}: FetchSitemapShardsOptions = {}): Promise<SitemapShard[]> => {
  const response = await fetchImpl(apiUrl("/case/sitemap/shards"), { signal });
  if (!response.ok) {
    throw new ClientOperationError({
      action: "fetchPublicCaseLawSitemapShards",
      message: `Failed to fetch public case-law sitemap shards: ${response.status}`,
    });
  }

  const parseResult = v.safeParse(
    sitemapShardPageSchema,
    await response.json(),
  );
  if (!parseResult.success) {
    throw new ClientOperationError({
      action: "parsePublicCaseLawSitemapShards",
      cause: parseResult.issues,
      message: "Public case-law sitemap shards had an unexpected shape.",
    });
  }

  return parseResult.output.items;
};

export const fetchPublicSitemapDecisions = async ({
  fetchImpl = fetch,
  shard,
  signal = AbortSignal.timeout(10_000),
}: FetchSitemapDecisionsOptions): Promise<SitemapDecision[]> => {
  const url = new URL(apiUrl("/case/sitemap/decisions/shard"));
  url.searchParams.set("country", shard.country);
  url.searchParams.set("year", shard.year);
  url.searchParams.set("month", shard.month);
  url.searchParams.set("bucket", shard.bucket);

  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new ClientOperationError({
      action: "fetchPublicCaseLawSitemap",
      message: `Failed to fetch public case-law sitemap data: ${response.status}`,
    });
  }

  const parseResult = v.safeParse(
    sitemapDecisionPageSchema,
    await response.json(),
  );
  if (!parseResult.success) {
    throw new ClientOperationError({
      action: "parsePublicCaseLawSitemap",
      cause: parseResult.issues,
      message: "Public case-law sitemap data had an unexpected shape.",
    });
  }

  return parseResult.output.items;
};

export const createPublicLawSitemapIndexXml = (
  shards: readonly SitemapShard[],
  options: number | PublicLawSitemapIndexOptions = {},
): string => {
  const { maxBytes, publicLawIndexingEnabled, publicToolsIndexingEnabled } =
    typeof options === "number"
      ? {
          maxBytes: options,
          publicLawIndexingEnabled: isPublicLawSitemapEnabled(),
          publicToolsIndexingEnabled: isPublicToolsSitemapEnabled(),
        }
      : {
          maxBytes: options.maxBytes ?? SITEMAP_XML_MAX_BYTES,
          publicLawIndexingEnabled:
            options.publicLawIndexingEnabled ?? isPublicLawSitemapEnabled(),
          publicToolsIndexingEnabled:
            options.publicToolsIndexingEnabled ??
            isPublicToolsSitemapEnabled(),
        };

  const lawEntries = publicLawIndexingEnabled
    ? [
        {
          loc: createPublicLawCanonicalUrl(LAW_SITEMAP_PATH),
          lastmod: shards.at(0)?.lastmod ?? null,
        },
        ...shards.map((shard) => ({
          loc: createPublicLawCanonicalUrl(createCaseLawShardPath(shard)),
          lastmod: shard.lastmod,
        })),
      ]
    : [];

  const toolsEntries = publicToolsIndexingEnabled
    ? [
        {
          loc: createPublicLawCanonicalUrl(TOOLS_SITEMAP_PATH),
          lastmod: null,
        },
      ]
    : [];

  const entries = [...lawEntries, ...toolsEntries]
    .map(
      ({ lastmod, loc }) => `  <sitemap>
    <loc>${xmlEscape(loc)}</loc>${
      lastmod ? `\n    <lastmod>${xmlEscape(lastmod)}</lastmod>` : ""
    }
  </sitemap>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>
`;

  assertPublicLawSitemapXmlWithinProtocolLimits(xml, maxBytes);

  return xml;
};

export const createPublicLawStaticSitemapXml = ({
  publicLawIndexingEnabled = isPublicLawSitemapEnabled(),
}: PublicLawIndexingOptions = {}): string => {
  if (!publicLawIndexingEnabled) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`;
  }

  const loc = createPublicLawCanonicalUrl("/law/cases");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${xmlEscape(loc)}</loc>
  </url>
</urlset>
`;
};

export const createPublicCaseLawSitemapXml = (
  decisions: readonly SitemapDecision[],
): string => {
  const entries = decisions.map((decision) => ({
    loc: createCaseLawDecisionSitemapUrl(decision),
    alternateLinks: createCaseLawDecisionSitemapAlternateLinks(decision),
    lastmod: decision.updatedAt.slice(0, 10),
  }));
  const namespace = entries.some((entry) => entry.alternateLinks.length > 0)
    ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"'
    : "";
  const serializedEntries = entries
    .map(
      ({ alternateLinks, lastmod, loc }) => `  <url>
    <loc>${xmlEscape(loc)}</loc>${
      lastmod ? `\n    <lastmod>${xmlEscape(lastmod)}</lastmod>` : ""
    }${alternateLinks
      .map(
        (alternate) =>
          `\n    <xhtml:link rel="alternate" hreflang="${xmlEscape(
            alternate.hreflang,
          )}" href="${xmlEscape(alternate.href)}" />`,
      )
      .join("")}
  </url>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${namespace}>
${serializedEntries}
</urlset>
`;

  assertPublicLawSitemapXmlWithinProtocolLimits(xml);

  return xml;
};

type RobotsTxtOptions = {
  publicLawCrawlAllowed?: boolean;
  publicToolsCrawlAllowed?: boolean;
  seoIndexable?: boolean;
};

export const createRobotsTxt = ({
  publicLawCrawlAllowed = isPublicLawCrawlAllowed(),
  publicToolsCrawlAllowed = isPublicToolsCrawlAllowed(),
  seoIndexable = env.VITE_SEO_INDEXABLE,
}: RobotsTxtOptions = {}): string => {
  // Non-indexable deployments serve a full crawl block: no path rules and no
  // Sitemap line, so crawlers stay out even when sitemaps are served for
  // verification.
  if (!seoIndexable) {
    return `User-agent: *
Disallow: /
`;
  }

  const sitemapUrl = new URL(
    "/sitemap.xml",
    env.VITE_PUBLIC_APP_URL,
  ).toString();
  const lawRule = publicLawCrawlAllowed ? "Allow: /law/" : "Disallow: /law/";
  const toolsRule = publicToolsCrawlAllowed
    ? "Allow: /tools/"
    : "Disallow: /tools/";

  return `User-agent: *
${lawRule}
${toolsRule}
Disallow: /auth
Disallow: /onboarding
Disallow: /consent
Disallow: /chat
Disallow: /workspaces
Disallow: /knowledge
Disallow: /settings
Disallow: /organization
Disallow: /todos
Disallow: /contacts
Sitemap: ${sitemapUrl}
`;
};
