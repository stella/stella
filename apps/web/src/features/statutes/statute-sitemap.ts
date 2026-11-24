import { Result } from "better-result";
import * as v from "valibot";

import { SITEMAP_FILE_FETCH_TIMEOUT_MS } from "@stll/api-contract/public-sitemap-budget";
import {
  createStatutePath,
  normalizeStatuteStoredSlug,
} from "@stll/api-contract/statute-route";

import { apiUrl } from "@/lib/api-url";
import { createPublicLawCanonicalUrl } from "@/lib/public-law-seo";
import {
  assertSitemapXmlWithinProtocolLimits,
  classifySitemapUpstreamFailure,
  escapeSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
  SitemapNotFoundError,
  SitemapReadFailedError,
  type SitemapReadFailure,
} from "@/lib/public-sitemap";
import { isPublicStatutePageCountry } from "@/lib/statutes/statute-route";

const LAW_STATUTES_SITEMAP_BASE_PATH = "/sitemaps/law-statutes";
const STATUTE_SITEMAP_ALL_BUCKET = "all";

type FetchLike = (
  input: Request | URL | string,
  init?: RequestInit,
) => Promise<Response>;

// Every shard aggregates at least one row, so the API always dates it.
const statuteSitemapShardSchema = v.strictObject({
  bucket: v.string(),
  country: v.string(),
  lastmod: v.string(),
});

const statuteSitemapWorkSchema = v.strictObject({
  country: v.string(),
  lastmod: v.string(),
  slug: v.string(),
});

const statuteSitemapShardPageSchema = v.strictObject({
  items: v.array(statuteSitemapShardSchema),
  limit: v.number(),
  nextCursor: v.nullable(v.string()),
});

const statuteSitemapWorkPageSchema = v.strictObject({
  items: v.array(statuteSitemapWorkSchema),
  limit: v.number(),
  nextCursor: v.nullable(v.string()),
});

export type StatuteSitemapShard = v.InferOutput<
  typeof statuteSitemapShardSchema
>;
type StatuteSitemapWork = v.InferOutput<typeof statuteSitemapWorkSchema>;

type StatuteSitemapShardRouteParams = {
  bucket: string;
  country: string;
};

type FetchStatuteSitemapShardsOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

type FetchStatuteSitemapWorksOptions = {
  fetchImpl?: FetchLike;
  shard: StatuteSitemapShardRouteParams;
  signal?: AbortSignal;
};

type ReadSitemapPageOptions<TSchema extends v.GenericSchema> = {
  action: string;
  addressesShard: boolean;
  fetchImpl: FetchLike;
  schema: TSchema;
  signal: AbortSignal;
  subject: string;
  url: URL | string;
};

type SitemapPageResult<TItem> = Promise<Result<TItem[], SitemapReadFailure>>;

export { SITEMAP_XML_RESPONSE_HEADERS };

export const createStatuteSitemapShardPath = ({
  bucket,
  country,
}: StatuteSitemapShardRouteParams): `/${string}` =>
  bucket === STATUTE_SITEMAP_ALL_BUCKET
    ? `${LAW_STATUTES_SITEMAP_BASE_PATH}/${country}.xml`
    : `${LAW_STATUTES_SITEMAP_BASE_PATH}/${country}/${bucket}.xml`;

const readSitemapPage = async <TSchema extends v.GenericSchema>({
  action,
  addressesShard,
  fetchImpl,
  schema,
  signal,
  subject,
  url,
}: ReadSitemapPageOptions<TSchema>): Promise<
  Result<v.InferOutput<TSchema>, SitemapReadFailure>
> => {
  const response = await Result.tryPromise(
    async () => await fetchImpl(url, { signal }),
  );
  if (response.isErr()) {
    return Result.err(
      new SitemapReadFailedError({
        action,
        cause: response.error,
        message: `Failed to reach the public ${subject} endpoint.`,
        reason: "upstream_unreachable",
        upstreamStatus: null,
      }),
    );
  }

  if (!response.value.ok) {
    return Result.err(
      classifySitemapUpstreamFailure({
        action,
        addressesShard,
        response: response.value,
      }),
    );
  }

  // `Response.json()` is typed `any`; the schema below is what gives the
  // payload a type, so it enters this module as `unknown`.
  const body = await Result.tryPromise(
    async (): Promise<unknown> => await response.value.json(),
  );
  if (body.isErr()) {
    return Result.err(
      new SitemapReadFailedError({
        action,
        cause: body.error,
        message: `Public ${subject} was not JSON.`,
        reason: "unexpected_payload",
        upstreamStatus: response.value.status,
      }),
    );
  }

  const parseResult = v.safeParse(schema, body.value);
  if (!parseResult.success) {
    return Result.err(
      new SitemapReadFailedError({
        action,
        cause: parseResult.issues,
        message: `Public ${subject} had an unexpected shape.`,
        reason: "unexpected_payload",
        upstreamStatus: response.value.status,
      }),
    );
  }

  return Result.ok(parseResult.output);
};

export const fetchPublicStatuteSitemapShards = async ({
  fetchImpl = fetch,
  signal = AbortSignal.timeout(SITEMAP_FILE_FETCH_TIMEOUT_MS),
}: FetchStatuteSitemapShardsOptions = {}): SitemapPageResult<StatuteSitemapShard> => {
  const page = await readSitemapPage({
    action: "fetchPublicStatuteSitemapShards",
    addressesShard: false,
    fetchImpl,
    schema: statuteSitemapShardPageSchema,
    signal,
    subject: "statute sitemap shards",
    url: apiUrl("/law/sitemap/shards"),
  });

  // The jurisdictions the statutes browser can render are the web's own
  // question; the corpus may hold more than the browser routes.
  return page.map(({ items }) =>
    items.filter(({ country }) => isPublicStatutePageCountry(country)),
  );
};

export const fetchPublicStatuteSitemapWorks = async ({
  fetchImpl = fetch,
  shard,
  signal = AbortSignal.timeout(SITEMAP_FILE_FETCH_TIMEOUT_MS),
}: FetchStatuteSitemapWorksOptions): SitemapPageResult<StatuteSitemapWork> => {
  if (!isPublicStatutePageCountry(shard.country)) {
    return Result.err(
      new SitemapNotFoundError({
        action: "fetchPublicStatuteSitemap",
        message: "The statute sitemap shard is not published.",
      }),
    );
  }

  const url = new URL(apiUrl("/law/sitemap/statutes/shard"));
  url.searchParams.set("country", shard.country);
  url.searchParams.set("bucket", shard.bucket);

  const page = await readSitemapPage({
    action: "fetchPublicStatuteSitemap",
    addressesShard: true,
    fetchImpl,
    schema: statuteSitemapWorkPageSchema,
    signal,
    subject: "statute sitemap data",
    url,
  });

  return page.map(({ items }) => items);
};

/**
 * One shard's statute URLs: the bare slug path, which always resolves to the
 * latest consolidation. The dated `/v/` addresses are alternate spellings of
 * the same Work and stay out of the index.
 */
export const createPublicStatuteSitemapXml = (
  works: readonly StatuteSitemapWork[],
): string => {
  const entries = works.flatMap((work) => {
    // A stored segment the router would not round-trip addresses its
    // document by the id form instead, and that form is not indexed.
    const slug = normalizeStatuteStoredSlug(work.slug);

    return slug === null
      ? []
      : [
          {
            loc: createPublicLawCanonicalUrl(
              createStatutePath({ country: work.country, slug }),
            ),
            lastmod: work.lastmod,
          },
        ];
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    ({ lastmod, loc }) => `  <url>
    <loc>${escapeSitemapXml(loc)}</loc>
    <lastmod>${escapeSitemapXml(lastmod)}</lastmod>
  </url>`,
  )
  .join("\n")}
</urlset>
`;

  assertSitemapXmlWithinProtocolLimits(xml);

  return xml;
};
