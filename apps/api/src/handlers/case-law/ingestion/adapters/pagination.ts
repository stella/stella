/**
 * Shared pagination helpers for case-law adapters.
 *
 * These reduce boilerplate in adapters that follow
 * common pagination patterns. Adapters with unique
 * pagination (CZ-constitutional enumeration, EU-ECJ
 * multi-language) should implement fetchPage directly.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  isTimeoutError,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Options for page-number pagination (1-indexed or
 * 0-indexed). Covers: SK, PL, AT, CZ-supreme-admin,
 * EE, HR, and similar adapters.
 */
/** One ordered walk over a collection, named so a cursor can carry it. */
export type TraversalMode = {
  /**
   * Persisted as the cursor prefix. Stable: changing it restarts the walk,
   * and it may not contain {@link TRAVERSAL_CURSOR_SEPARATOR}.
   */
  name: string;
  /** Request for a page within this walk. */
  buildRequest: PageRequestBuilder;
  /**
   * Where to continue once this walk reaches the end of the collection, or
   * null to stay in it.
   *
   * A walk may name itself. The handover writes `<successor>:0` either way,
   * so naming itself restarts this same walk from its own head — which is
   * what a walk that has to keep re-reading the same filtered window wants,
   * and what `null` cannot express: `null` parks the cursor at the end
   * instead, where the next cycle re-reads only the tail.
   */
  followedBy: string | null;
  /**
   * How many items this walk covers before returning to its own start.
   *
   * A walk that keeps a crawl current has to stay near the head. Without a
   * bound it advances deeper into the collection every cycle and ends parked
   * at the far tail, where it sees nothing new — the same non-convergence
   * the ordered walks exist to avoid, reached from the other end.
   *
   * Omit it for a walk that is meant to cross the whole collection once,
   * which is what catching up is.
   */
  windowItems?: number | undefined;
};

/**
 * The number a publisher gives its own first page. Every endpoint numbers
 * pages from one or from zero, and which one it is is a fact about that
 * endpoint that the adapter must state rather than infer.
 *
 * Getting it wrong is silent, because a clamping endpoint answers an
 * out-of-range page with its first one instead of an error: the walk then
 * re-reads that page every traversal and reads every later page one page
 * short of where its cursor says it is.
 */
export type FirstPageNumber = 0 | 1;

/** Build the request for one page inside a walk. */
export type PageRequestBuilder = (page: number) => {
  url: string;
  init?: RequestInit;
};

/**
 * One kind of walk an adapter knows how to make over its source, together
 * with the parameters that kind takes.
 *
 * The vocabulary is the mechanism and lives in code. Which walks are made, in
 * what order, over which windows, is policy and comes from the source's
 * configuration. `build` is handed one policy entry and answers either with
 * the request builder for it or with what is wrong with it, so a policy the
 * adapter cannot serve fails the page rather than being approximated.
 */
export type WalkKind = {
  readonly build: (
    entry: Readonly<Record<string, unknown>>,
  ) => Result<PageRequestBuilder, string>;
};

/**
 * How an adapter declares the walks it makes.
 *
 * `traversal` states them in code, for a source whose walks are a fact about
 * the endpoint. `walkKinds` states only what the adapter can serve and leaves
 * the choice to the configuration. Declaring both would leave which one is in
 * force to the reader, so the union makes that unrepresentable; declaring
 * neither is the plain offset walk over `buildRequest`.
 */
type PageWalkDeclaration =
  | {
      /**
       * Ordered walks over the same collection, where one walk cannot serve
       * both catching up and keeping up.
       *
       * A source sorted newest-first cannot be caught up by walking offsets
       * forward: every publication shifts each later offset, so items slide
       * past the cursor unseen and the crawl never converges. Walking
       * oldest-first does converge, because new items land at the end and the
       * offsets already walked never move. It is the wrong order to stay
       * current in, though, so a source needs both: oldest-first until the
       * collection has been seen, then newest-first from there on.
       *
       * The active mode is persisted in the cursor (`backfill:1200`) rather
       * than chosen per call, so a restart, a redeploy, or a second caller
       * all resume in the phase the crawl actually reached.
       */
      traversal: readonly TraversalMode[];
      walkKinds?: never;
    }
  | {
      /**
       * The walk kinds this adapter serves, keyed by the name a policy entry
       * gives in its `kind`. Total by construction: write the record
       * `as const satisfies Record<<the adapter's kind union>, WalkKind>` so
       * a new kind without a builder does not compile.
       */
      walkKinds: Readonly<Record<string, WalkKind>>;
      traversal?: never;
    }
  | { traversal?: never; walkKinds?: never };

type PagePaginationOptions<TResponse> = PageWalkDeclaration & {
  /** Adapter key for error context. */
  adapterKey: string;
  /**
   * The page number this endpoint gives its first page. Cursors are item
   * offsets either way: this is only how an offset is turned into the number
   * the publisher is asked for, so the page fetched for offset `n` always
   * begins at item `n - (n % pageSize)`.
   */
  firstPage: FirstPageNumber;
  /** Number of items per page (used to detect last page). */
  pageSize: number;
  /**
   * Page size used by existing bare page-number cursors.
   * New cursors are persisted as item offsets.
   */
  legacyPageSize?: number | undefined;
  /**
   * Build the fetch request for a given page number, for the plain walk the
   * adapter falls back to when no walks are declared or configured.
   */
  buildRequest: PageRequestBuilder;
  /**
   * Read the publisher's body into a typed page.
   *
   * An answer this adapter will not read is `Result.err`, not an exception:
   * the page then fails and its cursor is held, so the same page is asked
   * for again next cycle rather than being passed on as something it is not.
   * Reading a malformed body as an empty page is the failure this shape
   * exists to prevent — for a walk that hands over on a short page, an empty
   * page means the collection ended.
   *
   * A body that is not the declared format at all still rejects, because
   * `response.json()` does; that one keeps its single retry below, since a
   * publisher under load answers a 200 with an HTML notice and then answers
   * properly.
   */
  parseResponse: (
    response: Response,
  ) => Promise<Result<TResponse, AdapterFetchError>>;
  /**
   * Extract items from the parsed response.
   * Return the items and optional total count.
   */
  extractItems: (data: TResponse) => {
    items: unknown[];
    total?: number | undefined;
  };
  /**
   * Per-request timeout for the list/page fetch (ms).
   * Defaults to ADAPTER_TIMEOUT.LIST (15s).
   */
  listTimeoutMs?: number | undefined;
  /**
   * Transform a single raw item into an IngestionResult.
   * May perform secondary fetches (detail pages, fulltext).
   * Return null to skip the item.
   */
  parseItem: (
    item: unknown,
    signal?: AbortSignal,
  ) => Promise<IngestionResult | null>;
  /**
   * Max parallel parseItem calls within a single page.
   * Defaults to 1 (serial). Raise for adapters whose
   * parseItem performs detail fetches and where the
   * source can tolerate concurrent requests.
   */
  itemConcurrency?: number | undefined;
};

/**
 * Create a fetchPage function for page-number based
 * adapters. Handles cursor parsing, request building,
 * pagination logic, and error wrapping.
 *
 * @example
 * ```ts
 * export const myAdapter: SourceAdapter = {
 *   key: ADAPTER_KEYS.MY_ADAPTER,
 *   // ...
 *   fetchPage: createPagePaginatedFetch({
 *     adapterKey: ADAPTER_KEYS.MY_ADAPTER,
 *     pageSize: 20,
 *     firstPage: 1,
 *     buildRequest: (page) => ({
 *       url: `https://api.example.com/search?page=${page}`,
 *     }),
 *     parseResponse: async (resp) => Result.ok(await resp.json()),
 *     extractItems: (data) => ({
 *       items: data.results,
 *       total: data.totalCount,
 *     }),
 *     parseItem: async (raw) => transformToResult(raw),
 *   }),
 * };
 * ```
 */
/** Max retries for transient 5xx / timeout errors before skipping. */
const SERVER_ERROR_RETRIES = 2;

/**
 * The gateway got no usable answer from the origin: the upstream refused the
 * connection, dropped it, or replied unintelligibly.
 *
 * The page-skip below rests on a 5xx being a fact about the page — the
 * publisher ran the request and failed on it, so losing that one page beats
 * stalling the source. 502 carries no such fact. Nothing was read, so the
 * page's items are unknown rather than terminal, and advancing over them
 * checkpoints past pages nobody looked at.
 *
 * The cost only shows at scale: a publisher whose gateway is down answers
 * every page this way, so a skip that advances one page per refusal walks the
 * entire collection at the speed of the failures and leaves the cursor far
 * past the tip, where nothing new is ever listed again.
 *
 * Deliberately only 502. A 504 is the proxy's own read timeout, which the
 * origin earns by being slow on this page — the same event the client-side
 * timeout below skips, so holding it would decide identical situations
 * opposite ways on whose stopwatch was shorter. A 503 can come from the
 * origin itself. Both stay skippable.
 *
 * This puts 502 in the bucket 429 already occupies: hold, and ask again next
 * cycle. It inherits that bucket's open question too — neither is bounded, so
 * a page that answers this way forever holds its cursor forever.
 */
const BAD_GATEWAY_STATUS = 502;

/**
 * What divides a walk's name from its offset in a cursor. A cursor is split
 * on the FIRST one, so a name containing it names a walk that does not
 * exist: every cursor the walk writes then decodes as "no walk", which
 * restarts the crawl from the first walk on every step, silently and
 * forever. `assertNamesAreUsable` refuses that at construction.
 */
const TRAVERSAL_CURSOR_SEPARATOR = ":";

/**
 * What a plain offset cursor carries where a walk's cursor carries its name.
 *
 * Reserved for that reason: a walk of this name would read `offset:50000`,
 * written by the plain walk, as offset 50 000 inside itself, silently
 * skipping everything before it rather than starting the walk.
 */
const PLAIN_CURSOR_NAME = "offset";

const OFFSET_CURSOR_PREFIX = `${PLAIN_CURSOR_NAME}${TRAVERSAL_CURSOR_SEPARATOR}`;
const CANONICAL_NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;

export const encodeOffsetCursor = (offset: number): string =>
  `${OFFSET_CURSOR_PREFIX}${offset}`;

const parseCanonicalNonNegativeSafeInteger = (value: string): number | null => {
  if (!CANONICAL_NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

type DecodeOffsetCursorParams = {
  cursor: string | null;
  firstPage: number;
  legacyPageSize: number;
};

export const decodeOffsetCursor = ({
  cursor,
  firstPage,
  legacyPageSize,
}: DecodeOffsetCursorParams): number | null => {
  if (cursor === null) {
    return 0;
  }

  if (cursor.startsWith(OFFSET_CURSOR_PREFIX)) {
    return parseCanonicalNonNegativeSafeInteger(
      cursor.slice(OFFSET_CURSOR_PREFIX.length),
    );
  }

  const legacyPage = parseCanonicalNonNegativeSafeInteger(cursor);
  if (legacyPage === null) {
    return null;
  }

  const offset = (legacyPage - firstPage) * legacyPageSize;
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
};

/** Whether a cursor is `<walk>:<offset>`, whoever wrote that walk. */
const namesAWalk = (cursor: string): boolean => {
  const separator = cursor.indexOf(TRAVERSAL_CURSOR_SEPARATOR);
  return (
    separator > 0 &&
    parseCanonicalNonNegativeSafeInteger(cursor.slice(separator + 1)) !== null
  );
};

/**
 * The offset a plain walk resumes at.
 *
 * A cursor naming a walk reaches the plain walk whenever a source stops
 * configuring one, and the offset inside that walk points nowhere in the
 * unfiltered collection. So the plain walk starts over, which is what
 * {@link decodeTraversalCursor} answers a cursor naming an unknown walk and
 * for the same reason. Rejecting it instead would stall the source outright:
 * a failed page holds its cursor, and nothing else ever rewrites it, so the
 * next cycle would reject the very same cursor.
 *
 * A cursor that is neither shape is still rejected — that is a cursor nobody
 * here wrote, and reading it as "start over" would hide it forever.
 */
const decodePlainWalkCursor = (
  params: DecodeOffsetCursorParams,
): number | null => {
  const offset = decodeOffsetCursor(params);
  if (offset !== null) {
    return offset;
  }
  return params.cursor !== null && namesAWalk(params.cursor) ? 0 : null;
};

/**
 * The mode a cursor names and the offset within it.
 *
 * A cursor written before the adapter declared its walks names no mode. It
 * cannot be carried into one either, because an offset counted in one order
 * points somewhere unrelated in another, so the first walk restarts from its
 * beginning — which is what catching up requires anyway.
 */
export const decodeTraversalCursor = (
  cursor: string | null,
  modes: readonly TraversalMode[],
): { mode: TraversalMode; offset: number } | null => {
  const [first] = modes;
  if (first === undefined) {
    return null;
  }
  if (cursor === null) {
    return { mode: first, offset: 0 };
  }
  const separator = cursor.indexOf(TRAVERSAL_CURSOR_SEPARATOR);
  const named = modes.find((mode) => mode.name === cursor.slice(0, separator));
  if (separator === -1 || named === undefined) {
    return { mode: first, offset: 0 };
  }
  const offset = parseCanonicalNonNegativeSafeInteger(
    cursor.slice(separator + 1),
  );
  return offset === null ? null : { mode: named, offset };
};

export const encodeTraversalCursor = (mode: string, offset: number): string =>
  `${mode}${TRAVERSAL_CURSOR_SEPARATOR}${offset}`;

const nameCarriesSeparator = (name: string): boolean =>
  name.includes(TRAVERSAL_CURSOR_SEPARATOR);

const nameIsPlainCursorName = (name: string): boolean =>
  name === PLAIN_CURSOR_NAME;

const assertNamesAreUsable = (
  adapterKey: string,
  modes: readonly TraversalMode[],
): void => {
  for (const { name } of modes) {
    if (nameCarriesSeparator(name)) {
      panic(
        `${adapterKey}: traversal walk "${name}" contains ${TRAVERSAL_CURSOR_SEPARATOR}, which its cursors are split on`,
      );
    }
    if (nameIsPlainCursorName(name)) {
      panic(
        `${adapterKey}: traversal walk "${name}" is the name a plain offset cursor carries`,
      );
    }
  }
};

/**
 * The fields a policy entry carries whatever kind it names.
 *
 * The name is the walk's whole identity: it is all a cursor persists, and an
 * offset means "this far into whatever this name now covers". So a walk keeps
 * its name only while it covers the same thing. Widening a window under the
 * same name resumes the old offset inside the new one, which steps over
 * everything the widening added ahead of it; rename the walk instead, and the
 * cursor naming the old one restarts the crawl at the first walk.
 */
const WALK_ENTRY_FIELDS = {
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.check(
      (name) => !nameCarriesSeparator(name),
      `a walk name may not contain "${TRAVERSAL_CURSOR_SEPARATOR}", which its cursors are split on`,
    ),
    v.check(
      (name) => !nameIsPlainCursorName(name),
      `a walk may not be named "${PLAIN_CURSOR_NAME}", which is the name a plain offset cursor carries`,
    ),
  ),
  kind: v.pipe(v.string(), v.minLength(1)),
  windowItems: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
} as const;

/**
 * The walk policy inside a source's configuration.
 *
 * Loose on both levels: the configuration carries whatever else that source
 * needs, and an entry's own parameters belong to its kind, which validates
 * them itself. An absent or empty list is a source with no policy, which
 * walks the plain way.
 */
const walkEntrySchema = v.looseObject(WALK_ENTRY_FIELDS);

const walkPolicySchema = v.looseObject({
  walks: v.optional(v.array(walkEntrySchema), []),
});

type WalkPolicyEntry = v.InferOutput<typeof walkEntrySchema>;

/**
 * Declare one walk kind: the parameters it takes and how it turns them into
 * page requests.
 *
 * A policy entry is one flat object, so an undeclared key is refused rather
 * than ignored: a mistyped parameter would otherwise read as an absent one
 * and the walk would quietly ask the publisher for something else.
 */
export const defineWalkKind = <TParams extends v.ObjectEntries>(
  params: TParams,
  buildRequest: (
    params: v.InferOutput<v.LooseObjectSchema<TParams, undefined>>,
  ) => PageRequestBuilder,
): WalkKind => {
  const schema = v.looseObject(params);
  const declared = new Set([
    ...Object.keys(WALK_ENTRY_FIELDS),
    ...Object.keys(params),
  ]);

  return {
    build: (entry) => {
      const undeclared = Object.keys(entry).filter((key) => !declared.has(key));
      if (undeclared.length > 0) {
        return Result.err(`does not take ${undeclared.join(", ")}`);
      }
      const parsed = v.safeParse(schema, entry);
      return parsed.success
        ? Result.ok(buildRequest(parsed.output))
        : Result.err(v.summarize(parsed.issues));
    },
  };
};

type MaterialiseWalksOptions = {
  adapterKey: string;
  config: Record<string, unknown>;
  cursor: string | null;
  walkKinds: Readonly<Record<string, WalkKind>>;
};

/**
 * Turn a source's walk policy into the walks the helper drives.
 *
 * The list is the chain: each entry is followed by the next, and the last
 * names itself, so a policy that ends on a lane meant to stay near the head
 * restarts there instead of parking the crawl on its tail.
 *
 * Policy the adapter cannot serve is refused. Materialising fewer walks than
 * were asked for, or falling back to the plain walk, would leave the crawl
 * reading a collection nobody chose while every page still reported success.
 */
const materialiseConfiguredWalks = ({
  adapterKey,
  config,
  cursor,
  walkKinds,
}: MaterialiseWalksOptions): Result<TraversalMode[], AdapterFetchError> => {
  const refuse = (detail: string): Result<never, AdapterFetchError> =>
    Result.err(
      new AdapterFetchError({
        message: `${adapterKey}: unusable walk policy — ${detail}`,
        adapterKey,
        cursor,
      }),
    );

  // The column is JSON, so a row can hold any JSON value, and older rows do
  // hold a string. A value that is not an object cannot carry a `walks` key,
  // so it states no policy — the plain walk — rather than a broken one. Only
  // a stated policy can be malformed, and that still refuses below.
  if (!isRecord(config)) {
    return Result.ok([]);
  }

  const parsed = v.safeParse(walkPolicySchema, config);
  if (!parsed.success) {
    return refuse(v.summarize(parsed.issues));
  }

  const entries: readonly WalkPolicyEntry[] = parsed.output.walks;
  const seen = new Set<string>();
  const modes: TraversalMode[] = [];

  for (const [index, entry] of entries.entries()) {
    // A repeated name is unreachable rather than wrong-looking: a cursor
    // naming it always decodes to the first walk that carries it.
    if (seen.has(entry.name)) {
      return refuse(`two walks are named "${entry.name}"`);
    }
    seen.add(entry.name);

    const kind = walkKinds[entry.kind];
    if (kind === undefined) {
      return refuse(
        `walk "${entry.name}" names kind "${entry.kind}", which this adapter does not serve`,
      );
    }

    const built = kind.build(entry);
    if (Result.isError(built)) {
      return refuse(`walk "${entry.name}" ${built.error}`);
    }

    modes.push({
      name: entry.name,
      buildRequest: built.value,
      followedBy: entries[index + 1]?.name ?? entry.name,
      ...(entry.windowItems === undefined
        ? {}
        : { windowItems: entry.windowItems }),
    });
  }

  return Result.ok(modes);
};

type ParsedPageItems = {
  decisions: IngestionResult[];
  itemsSkipped: number;
  processedThroughIndex: number;
};

type ParsePageItemsOptions = {
  adapterKey: string;
  items: unknown[];
  itemConcurrency?: number | undefined;
  page: number;
  parseItem: PagePaginationOptions<unknown>["parseItem"];
  signal?: AbortSignal | undefined;
};

const parsePageItems = async ({
  adapterKey,
  items,
  itemConcurrency,
  page,
  parseItem,
  signal,
}: ParsePageItemsOptions): Promise<ParsedPageItems> => {
  const decisions: IngestionResult[] = [];
  let itemsSkipped = 0;
  let processedThroughIndex = 0;
  const chunkSize = Math.max(1, itemConcurrency ?? 1);
  // Complete chunks sequentially so an abort can rewind to the last durable
  // chunk boundary. Replaying that chunk is safe because inserts are
  // idempotent; advancing past an in-flight chunk would lose decisions.
  for (let i = 0; i < items.length; i += chunkSize) {
    if (signal?.aborted) {
      break;
    }
    const chunk = items.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map(async (item) => await parseItem(item, signal)),
    );
    if (signal?.aborted) {
      break;
    }
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value) {
          decisions.push(result.value);
        }
      } else {
        // A poison item is isolated from the rest of the page. The skip is
        // counted and logged below so it remains operator-visible.
        itemsSkipped++;
      }
    }
    processedThroughIndex = i + chunk.length;
  }
  if (itemsSkipped > 0) {
    logger.warn("case_law.ingestion.page_items_skipped", {
      adapterKey,
      page,
      skipped: itemsSkipped,
      total: items.length,
    });
  }
  return { decisions, itemsSkipped, processedThroughIndex };
};

const resolveNextCursor = ({
  encode,
  fetched,
  fetchedItemsCount,
  hasMore,
  offset,
  pageSize,
  pageStartOffset,
  processedItemsCount,
  processedThroughIndex,
  signal,
}: {
  encode: (offset: number) => string;
  fetched: number;
  fetchedItemsCount: number;
  hasMore: boolean;
  offset: number;
  pageSize: number;
  pageStartOffset: number;
  processedItemsCount: number;
  processedThroughIndex: number;
  signal?: AbortSignal | undefined;
}): string => {
  if (signal?.aborted) {
    return encode(offset + processedThroughIndex);
  }
  if (hasMore) {
    return encode(fetched);
  }
  if (fetchedItemsCount > 0) {
    return encode(offset + processedItemsCount);
  }
  return encode(Math.max(0, pageStartOffset - pageSize));
};

export const createPagePaginatedFetch = <TResponse>(
  opts: PagePaginationOptions<TResponse>,
) => {
  const { firstPage, walkKinds } = opts;
  const declaredModes = opts.traversal;
  if (declaredModes !== undefined) {
    assertNamesAreUsable(opts.adapterKey, declaredModes);
  }

  return async (
    cursor: string | null,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result<SyncPage, AdapterFetchError>> => {
    const attempt = await Result.tryPromise({
      try: async (): Promise<Result<SyncPage, AdapterFetchError>> => {
        // Materialised per call rather than once at construction: the policy
        // lives in the source's configuration, which the runner reads fresh,
        // and a lane whose window is derived from the current day has to be
        // built on the day it runs.
        let modes = declaredModes;
        if (walkKinds !== undefined) {
          const configured = materialiseConfiguredWalks({
            adapterKey: opts.adapterKey,
            config,
            cursor,
            walkKinds,
          });
          if (Result.isError(configured)) {
            return configured;
          }
          // No policy is not an empty traversal: it is the plain walk.
          modes = configured.value.length > 0 ? configured.value : undefined;
        }

        const walk = modes ? decodeTraversalCursor(cursor, modes) : null;
        const offset = walk
          ? walk.offset
          : decodePlainWalkCursor({
              cursor,
              firstPage,
              legacyPageSize: opts.legacyPageSize ?? opts.pageSize,
            });

        if (offset === null) {
          throw new AdapterFetchError({
            message: `${opts.adapterKey}: invalid cursor`,
            adapterKey: opts.adapterKey,
            cursor,
          });
        }

        const pageIndex = Math.floor(offset / opts.pageSize);
        const page = firstPage + pageIndex;
        const pageStartOffset = pageIndex * opts.pageSize;
        const itemsAlreadyFetched = offset - pageStartOffset;
        // Every cursor this call writes goes through here, including the
        // skip-ahead ones below. A bare offset written while a walk is
        // active would name no walk, and the next call would read that as
        // "start over" — one timeout would discard the whole traversal.
        const encode = walk
          ? (at: number): string => encodeTraversalCursor(walk.mode.name, at)
          : encodeOffsetCursor;

        const { url, init } = (walk?.mode ?? opts).buildRequest(page);
        const fetchT0 = performance.now();
        const listTimeout = opts.listTimeoutMs ?? ADAPTER_TIMEOUT.LIST;

        // fetchWithRetry handles timeout/5xx/429 with exponential
        // backoff. All page-paginated adapters inherit this.
        let response: Response;
        try {
          response = await fetchWithRetry(url, init, {
            maxRetries: SERVER_ERROR_RETRIES,
            timeoutMs: listTimeout,
            signal,
            adapterKey: opts.adapterKey,
          });
        } catch (error) {
          // Parent signal aborted: propagate for pipeline handling
          if (signal?.aborted) {
            throw error;
          }
          // Timeout after all retries: skip this page so the
          // adapter doesn't stall on a single slow page.
          // Network errors (DNS, connection refused) propagate
          // so a transient outage doesn't permanently skip pages.
          // A slow publisher is an expected operational failure, so no
          // per-page exception capture (see the pipeline's halt path):
          // the skip is logged, and the coverage ledger records the
          // shortfall the skipped page leaves behind.
          if (isTimeoutError(error)) {
            logger.warn("case_law.ingestion.page_skipped_timeout", {
              adapterKey: opts.adapterKey,
              page: String(page),
              retries: String(SERVER_ERROR_RETRIES),
            });
            return Result.ok({
              decisions: [],
              nextCursor: encode(pageStartOffset + opts.pageSize),
            });
          }
          throw error;
        }

        if (!response.ok) {
          // A 5xx the origin itself produced, after all retries: skip this
          // page and advance.
          // 429 is NOT skipped — it's transient throttling, not
          // a page error. The cursor stays put so the page is
          // retried in the next cycle. 502 joins it for the same reason
          // (see BAD_GATEWAY_STATUS): nothing was read, so there is nothing
          // to advance past.
          if (
            response.status >= 500 &&
            response.status !== BAD_GATEWAY_STATUS
          ) {
            // Same rule as the timeout skip above: a publisher-side 5xx
            // is operational, logged per page, and aggregated by the
            // coverage ledger rather than captured per attempt.
            logger.warn("case_law.ingestion.page_skipped_server_error", {
              adapterKey: opts.adapterKey,
              httpStatus: String(response.status),
              page: String(page),
            });
            return Result.ok({
              decisions: [],
              nextCursor: encode(pageStartOffset + opts.pageSize),
            });
          }

          throw new AdapterFetchError({
            message: `${opts.adapterKey}: HTTP ${response.status}`,
            adapterKey: opts.adapterKey,
            cursor,
            httpStatus: response.status,
          });
        }

        const retryFailed = (detail: string): AdapterFetchError =>
          new AdapterFetchError({
            message: `${opts.adapterKey}: page ${page} retry ${detail}`,
            adapterKey: opts.adapterKey,
            cursor,
          });

        // A refusal comes back as Err and ends the page here: the adapter
        // read the body and will not have it, which one more request cannot
        // change. Only a body that would not parse at all is retried.
        const readPage = async (): Promise<
          Result<TResponse, AdapterFetchError>
        > => {
          try {
            return await opts.parseResponse(response);
          } catch (parseError) {
            // Some court APIs return HTML error pages with 200 status
            // (rate limits, maintenance). Retry once after a delay.
            if (!(parseError instanceof SyntaxError)) {
              throw parseError;
            }
            const contentType =
              response.headers.get("content-type") ?? "unknown";
            logger.warn("case_law.ingestion.page_unparseable_retry", {
              adapterKey: opts.adapterKey,
              page,
              mediaType: contentType,
            });
            const retryResponse = await fetchWithRetry(url, init, {
              maxRetries: 1,
              timeoutMs: listTimeout,
              signal,
              adapterKey: opts.adapterKey,
            });
            if (!retryResponse.ok) {
              return Result.err(
                new AdapterFetchError({
                  message: `${opts.adapterKey}: retry HTTP ${retryResponse.status}`,
                  adapterKey: opts.adapterKey,
                  cursor,
                  httpStatus: retryResponse.status,
                }),
              );
            }
            try {
              const retried = await opts.parseResponse(retryResponse);
              return Result.isError(retried)
                ? Result.err(
                    retryFailed(`validation failed: ${retried.error.message}`),
                  )
                : retried;
            } catch (retryParseError) {
              const retryContentType =
                retryResponse.headers.get("content-type") ?? "unknown";
              return Result.err(
                retryFailed(
                  retryParseError instanceof SyntaxError
                    ? `unparseable (content-type: ${retryContentType})`
                    : `validation failed: ${retryParseError instanceof Error ? retryParseError.message : String(retryParseError)}`,
                ),
              );
            }
          }
        };

        const parsed = await readPage();
        if (Result.isError(parsed)) {
          return parsed;
        }
        const data = parsed.value;
        const fetchMs = Math.round(performance.now() - fetchT0);
        const { items: fetchedItems, total } = opts.extractItems(data);
        const items = fetchedItems.slice(itemsAlreadyFetched);
        const parsedItems = await parsePageItems({
          adapterKey: opts.adapterKey,
          items,
          itemConcurrency: opts.itemConcurrency,
          page,
          parseItem: opts.parseItem,
          signal,
        });
        const { decisions, itemsSkipped, processedThroughIndex } = parsedItems;

        const totalMs = Math.round(performance.now() - fetchT0);
        logger.info("case_law.ingestion.page_completed", {
          adapterKey: opts.adapterKey,
          page,
          offset,
          skippedOffsetItems: itemsAlreadyFetched,
          decisions: decisions.length,
          items: items.length,
          skipped: itemsSkipped,
          totalMs,
          fetchMs,
          ...(total !== undefined ? { sourceTotal: total } : {}),
        });

        const fetched = pageStartOffset + fetchedItems.length;
        const hasMore =
          fetchedItems.length >= opts.pageSize &&
          (total === undefined || fetched < total);

        // On abort, rewind to the start of the in-flight chunk so the
        // next cycle re-processes it.
        // When exhausted with results, park at the current offset
        // so the next cycle can detect stagnation without
        // re-processing the already consumed page tail.
        // When exhausted with zero results (overshot past end),
        // step back so the cursor recovers into the valid range.
        let nextCursor = resolveNextCursor({
          encode,
          fetched,
          fetchedItemsCount: fetchedItems.length,
          hasMore,
          offset,
          pageSize: opts.pageSize,
          pageStartOffset,
          processedItemsCount: items.length,
          processedThroughIndex,
          signal,
        });

        // A bounded walk returns to its own start rather than carrying on
        // deeper. Reaching the edge of the window is not the end of
        // anything, so this is not a handover: the walk simply begins again
        // at the head, which is where the new items are.
        const windowItems = walk?.mode.windowItems;
        if (
          walk !== null &&
          windowItems !== undefined &&
          !signal?.aborted &&
          fetched >= windowItems
        ) {
          nextCursor = encodeTraversalCursor(walk.mode.name, 0);
        }

        // This walk has reached the end of the collection, so hand over to
        // the one that follows it, starting at its own beginning. Handing
        // over only here is what makes the switch a fact about the crawl
        // rather than a guess: the collection has demonstrably been seen.
        const successor = walk === null ? null : walk.mode.followedBy;
        if (
          walk !== null &&
          successor !== null &&
          !signal?.aborted &&
          !hasMore
        ) {
          logger.info("case_law.ingestion.traversal_advanced", {
            adapterKey: opts.adapterKey,
            from: walk.mode.name,
            to: successor,
            offset: fetched,
            ...(total !== undefined ? { sourceTotal: total } : {}),
          });
          nextCursor = encodeTraversalCursor(successor, 0);
        }

        return Result.ok({ decisions, nextCursor, sourceUrl: url });
      },
      catch: adapterCatch(opts.adapterKey, cursor),
    });

    // The walk's own refusals and the thrown ones arrive nested one level
    // apart; both are the same failure to the caller.
    return attempt.andThen((page) => page);
  };
};
