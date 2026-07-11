import { createServerFn } from "@tanstack/react-start";
import * as v from "valibot";

import {
  githubRawContentBaseUrl,
  isGithubSkillEntry,
  loadCatalogue,
} from "@stll/catalogue";

import { isPublicToolsRouteEnabled } from "@/lib/public-tools-launch";
import { MAX_GITHUB_SKILL_BYTES } from "@/routes/tools/-components/tool-detail.logic";

/**
 * Result of fetching a github-sourced skill's `SKILL.md`. Deliberately
 * a two-state union with no error detail: the public detail page only
 * decides "render markdown" vs "degrade to metadata + external link".
 */
export type GithubSkillContentResult =
  | { status: "ok"; markdown: string }
  | { status: "error" };

// The RPC input is a catalogue slug, not a repo/rev pair: the server
// resolves the pin from the static bundle, so this endpoint can only
// ever fetch content the catalogue actually references (no arbitrary
// GitHub fetch proxy) and the cache is bounded by the entry count.
const inputSchema = v.strictObject({
  slug: v.string(),
});

// A broken upstream (404, rate limit, timeout) is remembered for this long
// so it costs at most one outbound fetch per pin per window. GitHub's
// anonymous limit is 60/h/IP, so an uncached error would otherwise turn
// every anonymous page view into a fresh outbound fetch.
export const NEGATIVE_CACHE_TTL_MS = 60_000;

// One cache serves three states keyed by the immutable pin:
//   - pending:  an outbound fetch is in flight; concurrent callers share
//     the same promise instead of stampeding the upstream.
//   - resolved success: content at a pinned SHA is immutable, so it is
//     retained for the process lifetime (`expiresAt` is +Infinity).
//   - resolved error: retained only until `expiresAt` (now + TTL), then
//     the next caller refetches. A transient failure never poisons the
//     entry past the window.
type SkillCacheEntry =
  | { state: "pending"; promise: Promise<GithubSkillContentResult> }
  | {
      state: "resolved";
      result: GithubSkillContentResult;
      expiresAt: number;
    };

const skillCache = new Map<string, SkillCacheEntry>();

/**
 * Read a response body, aborting the moment accumulated bytes exceed
 * `maxBytes`. Returns the decoded text, or `null` when the cap is blown
 * (an over-cap or unbounded chunked body is never buffered in full).
 * Chunk boundaries can split a multi-byte UTF-8 sequence, so bytes are
 * concatenated and decoded once at the end rather than per chunk.
 */
export const readCappedBody = async (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- sequential stream read: cap must be checked before pulling the next chunk
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      overflowed = true;
      break;
    }
    chunks.push(value);
  }
  if (overflowed) {
    await reader.cancel();
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

const loadRawSkill = async (url: string): Promise<GithubSkillContentResult> => {
  // Boundary layer: an external fetch to an untrusted host. Any failure
  // (timeout, non-200, oversize, parse) degrades to metadata-only.
  try {
    // The URL is pinned to raw.githubusercontent.com at an immutable
    // SHA: it must never redirect, so a redirect signals tampering or a
    // moved host and is rejected rather than followed to an arbitrary
    // origin.
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || !response.body) {
      return { status: "error" };
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_GITHUB_SKILL_BYTES
    ) {
      return { status: "error" };
    }
    // Stream and cap: a chunked response omits content-length, so the
    // pre-check above cannot catch it. Reading incrementally aborts an
    // oversize body before it is fully buffered.
    const markdown = await readCappedBody(
      response.body,
      MAX_GITHUB_SKILL_BYTES,
    );
    if (markdown === null) {
      return { status: "error" };
    }
    return { status: "ok", markdown };
  } catch {
    return { status: "error" };
  }
};

type ResolveWithCacheOptions = {
  cache: Map<string, SkillCacheEntry>;
  now: () => number;
};

/**
 * Run `fetcher` under the pin-keyed cache, deduplicating concurrent
 * callers onto a single in-flight promise and honoring the success /
 * negative-TTL retention policy described on {@link SkillCacheEntry}.
 * Exported for tests; production callers go through
 * {@link resolveGithubSkillContent}.
 */
export const resolveWithCache = (
  key: string,
  fetcher: () => Promise<GithubSkillContentResult>,
  { cache, now }: ResolveWithCacheOptions,
): Promise<GithubSkillContentResult> => {
  const existing = cache.get(key);
  if (existing) {
    if (existing.state === "pending") {
      return existing.promise;
    }
    if (existing.expiresAt > now()) {
      return Promise.resolve(existing.result);
    }
    // A negative entry that outlived its TTL falls through to a refetch.
  }
  const promise = (async (): Promise<GithubSkillContentResult> => {
    const result = await fetcher();
    // Successes are immutable (pinned SHA) so they never expire; errors
    // get a short TTL so a broken upstream is retried, not memoized.
    const expiresAt =
      result.status === "ok"
        ? Number.POSITIVE_INFINITY
        : now() + NEGATIVE_CACHE_TTL_MS;
    cache.set(key, { state: "resolved", result, expiresAt });
    return result;
  })().catch((): GithubSkillContentResult => {
    // `loadRawSkill` already catches internally, so a rejection here is
    // defensive: still land it as a TTL'd negative entry so the in-flight
    // slot is not poisoned past the window.
    const result: GithubSkillContentResult = { status: "error" };
    cache.set(key, {
      state: "resolved",
      result,
      expiresAt: now() + NEGATIVE_CACHE_TTL_MS,
    });
    return result;
  });
  // Publish the in-flight promise so concurrent callers share this fetch.
  cache.set(key, { state: "pending", promise });
  return promise;
};

type ResolveGithubSkillContentOptions = {
  isEnabled?: () => boolean;
  fetchRawSkill?: (url: string) => Promise<GithubSkillContentResult>;
  now?: () => number;
  cache?: Map<string, SkillCacheEntry>;
};

/**
 * Resolve a github-sourced skill's `SKILL.md`, gated on the public-tools
 * launch flag and served through the pin-keyed cache. Dependencies are
 * injectable for tests; production callers omit them to use the real
 * launch gate, fetcher, clock, and module cache.
 */
export const resolveGithubSkillContent = (
  slug: string,
  {
    isEnabled = isPublicToolsRouteEnabled,
    fetchRawSkill = loadRawSkill,
    now = Date.now,
    cache = skillCache,
  }: ResolveGithubSkillContentOptions = {},
): Promise<GithubSkillContentResult> => {
  // The route's `beforeLoad` gates rendering, not this RPC: a flag-off
  // deployment must not expose an unauthenticated outbound GitHub fetch,
  // so the gate is enforced here before any network work.
  if (!isEnabled()) {
    return Promise.resolve({ status: "error" });
  }
  const entry = loadCatalogue().find(
    (candidate) => candidate.kind === "skill" && candidate.slug === slug,
  );
  if (!entry || !isGithubSkillEntry(entry)) {
    return Promise.resolve({ status: "error" });
  }
  const key = `${entry.repo}@${entry.rev}/${entry.directory ?? ""}`;
  return resolveWithCache(
    key,
    () => fetchRawSkill(`${githubRawContentBaseUrl(entry)}SKILL.md`),
    { cache, now },
  );
};

/**
 * Server function: fetch a github-sourced skill's `SKILL.md` at its
 * pinned SHA from `raw.githubusercontent.com`, with a launch-flag gate, a
 * timeout, a byte cap, in-flight dedup, and TTL negative caching. Runs
 * server-side during SSR and via RPC on client navigation.
 */
export const fetchGithubSkillContent = createServerFn({ method: "GET" })
  .validator((input: v.InferInput<typeof inputSchema>) =>
    v.parse(inputSchema, input),
  )
  .handler(
    ({ data }): Promise<GithubSkillContentResult> =>
      resolveGithubSkillContent(data.slug),
  );
