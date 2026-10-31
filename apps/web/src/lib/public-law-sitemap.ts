import * as v from "valibot";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type { CaseLawDecisionLanguageAlternate } from "@stll/api-contract/case-law-decision-route";
import {
  PUBLIC_ROBOTS_DENIED_USER_AGENTS,
  ROBOTS_DISALLOWED_PATHS,
} from "@stll/api-contract/public-crawl-rules";

import { env } from "@/env";
import { publicCaseLawPageCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import {
  createStatuteSitemapShardPath,
  type StatuteSitemapShard,
} from "@/features/statutes/statute-sitemap";
import { apiUrl } from "@/lib/api-url";
import {
  type CaseLawLanguageAlternateLink,
  createCaseLawLanguageAlternateLinks,
} from "@/lib/case-law-language-alternates";
import { ClientOperationError } from "@/lib/errors/client";
import { isPublicKnowledgeCrawlAllowed } from "@/lib/knowledge/public-knowledge-launch";
import { publicToolsBasePath } from "@/lib/knowledge/public-tools-path";
import {
  isPublicLawCrawlAllowed,
  isPublicLawSitemapEnabled,
} from "@/lib/public-law-launch";
import { createPublicLawCanonicalUrl } from "@/lib/public-law-seo";
import {
  assertSitemapXmlWithinProtocolLimits,
  createSitemapUpstreamBusyError,
  escapeSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
  TOOLS_SITEMAP_PATH,
} from "@/lib/public-sitemap";
import {
  isPublicToolsCrawlAllowed,
  isPublicToolsSitemapEnabled,
} from "@/lib/public-tools-launch";
import { isPublicStatutePageCountry } from "@/lib/statutes/statute-route";
import {
  createPublicCrawlRules,
  isPublicLawPathIndexable,
} from "@/public-crawl-policy";

const LAW_SITEMAP_PATH = "/sitemaps/law.xml";
const LAW_CASES_SITEMAP_BASE_PATH = "/sitemaps/law-cases";

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
  languageAlternates: readonly CaseLawDecisionLanguageAlternate[];
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
  /** Statute shards, which have their own shard family and API route. */
  statuteShards?: readonly StatuteSitemapShard[];
};

type PublicLawIndexingOptions = {
  publicLawIndexingEnabled?: boolean;
};

type SitemapShardRouteParams = {
  bucket: string;
  country: string;
  month: string;
  year: string;
};

export { SITEMAP_XML_RESPONSE_HEADERS };
export { assertSitemapXmlWithinProtocolLimits as assertPublicLawSitemapXmlWithinProtocolLimits };

const createCaseLawDecisionSitemapUrl = (
  decision: SitemapDecisionUrlInput,
): string => {
  const params = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
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
    throw response.status === 429
      ? createSitemapUpstreamBusyError({
          action: "fetchPublicCaseLawSitemapShards",
          response,
        })
      : new ClientOperationError({
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

  return parseResult.output.items.filter(
    ({ country }) => publicCaseLawPageCountryFromParam(country) !== null,
  );
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

  const response =
    publicCaseLawPageCountryFromParam(shard.country) === null
      ? null
      : await fetchImpl(url, { signal });
  if (response === null || !response.ok) {
    throw response?.status === 429
      ? createSitemapUpstreamBusyError({
          action: "fetchPublicCaseLawSitemap",
          response,
        })
      : new ClientOperationError({
          action: "fetchPublicCaseLawSitemap",
          message:
            response === null
              ? "The case-law sitemap shard is not published."
              : `Failed to fetch public case-law sitemap data: ${response.status}`,
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
  const resolvedOptions: PublicLawSitemapIndexOptions =
    typeof options === "number" ? { maxBytes: options } : options;
  const {
    maxBytes,
    publicLawIndexingEnabled = isPublicLawSitemapEnabled(),
    publicToolsIndexingEnabled = isPublicToolsSitemapEnabled(),
    statuteShards = [],
  } = resolvedOptions;

  const publicShards = shards.filter(
    ({ country }) => publicCaseLawPageCountryFromParam(country) !== null,
  );
  const publicStatuteShards = statuteShards.filter(({ country }) =>
    isPublicStatutePageCountry(country),
  );
  const lawEntries = publicLawIndexingEnabled
    ? [
        {
          loc: createPublicLawCanonicalUrl(LAW_SITEMAP_PATH),
          lastmod: publicShards.at(0)?.lastmod ?? null,
        },
        ...publicShards.map((shard) => ({
          loc: createPublicLawCanonicalUrl(createCaseLawShardPath(shard)),
          lastmod: shard.lastmod,
        })),
        ...publicStatuteShards.map((shard) => ({
          loc: createPublicLawCanonicalUrl(
            createStatuteSitemapShardPath(shard),
          ),
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
    <loc>${escapeSitemapXml(loc)}</loc>${
      lastmod ? `\n    <lastmod>${escapeSitemapXml(lastmod)}</lastmod>` : ""
    }
  </sitemap>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>
`;

  assertSitemapXmlWithinProtocolLimits(xml, maxBytes);

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

  // The home is the entry point. The coverage page is not listed: it renders
  // its figures client-side, so a crawler sees only the pending shape, and
  // robots.txt does not allow it. The results screen is not listed either: an
  // unfiltered request redirects to the home, and every decision has its own
  // entry in the per-country sitemaps. A candidate is listed only when the
  // crawl policy that builds robots.txt allows it.
  const entries = (["/law"] as const)
    .filter((path) => isPublicLawPathIndexable(path, true))
    .map((path) => createPublicLawCanonicalUrl(path));

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (loc) => `  <url>
    <loc>${escapeSitemapXml(loc)}</loc>
  </url>`,
  )
  .join("\n")}
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
    <loc>${escapeSitemapXml(loc)}</loc>${
      lastmod ? `\n    <lastmod>${escapeSitemapXml(lastmod)}</lastmod>` : ""
    }${alternateLinks
      .map(
        (alternate) =>
          `\n    <xhtml:link rel="alternate" hreflang="${escapeSitemapXml(
            alternate.hreflang,
          )}" href="${escapeSitemapXml(alternate.href)}" />`,
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

  assertSitemapXmlWithinProtocolLimits(xml);

  return xml;
};

type RobotsTxtOptions = {
  publicKnowledgeCrawlAllowed?: boolean;
  publicLawCrawlAllowed?: boolean;
  publicToolsCrawlAllowed?: boolean;
  seoIndexable?: boolean;
};

const createDeniedCrawlerRules = () =>
  PUBLIC_ROBOTS_DENIED_USER_AGENTS.flatMap((userAgent) => [
    `User-agent: ${userAgent}`,
    "Disallow: /",
  ]);

export const createRobotsTxt = ({
  publicKnowledgeCrawlAllowed = isPublicKnowledgeCrawlAllowed(),
  publicLawCrawlAllowed = isPublicLawCrawlAllowed(),
  publicToolsCrawlAllowed = isPublicToolsCrawlAllowed(),
  seoIndexable = env.VITE_SEO_INDEXABLE,
}: RobotsTxtOptions = {}): string => {
  // Non-indexable deployments serve a full crawl block: no path rules and no
  // Sitemap line, so crawlers stay out even when sitemaps are served for
  // verification.
  if (!seoIndexable) {
    return `${[
      "User-agent: *",
      "Disallow: /",
      ...createDeniedCrawlerRules(),
    ].join("\n")}\n`;
  }

  const sitemapUrl = new URL(
    "/sitemap.xml",
    env.VITE_PUBLIC_APP_URL,
  ).toString();

  const allowLines = createPublicCrawlRules({
    publicKnowledgeCrawlAllowed,
    publicLawCrawlAllowed,
    publicToolsCrawlAllowed,
    toolsBasePath: publicToolsBasePath(),
  }).flatMap(({ path, scope }) =>
    scope === "exact"
      ? [`Allow: ${path}$`]
      : [`Allow: ${path}/`, `Allow: ${path}$`],
  );

  return `${[
    "User-agent: *",
    ...ROBOTS_DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    ...allowLines,
    "Disallow: /",
    `Sitemap: ${sitemapUrl}`,
    ...createDeniedCrawlerRules(),
  ].join("\n")}
`;
};
