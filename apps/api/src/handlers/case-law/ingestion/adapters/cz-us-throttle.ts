import { panic, Result, TaggedError } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import {
  createPublisherSlot,
  NALUS_DAILY_REQUEST_LIMIT,
  publisherRequestIntervalMs,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import type { PublisherRequestGateDependencies } from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

/**
 * What one NALUS request costs the crawl in waiting, read off the policy map
 * so the page budget this adapter sizes itself against cannot drift from the
 * gate that enforces it.
 */
export const NALUS_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(
  ADAPTER_KEYS.CZ_US,
);

const NALUS_ORIGIN = "https://nalus.usoud.cz";
const NALUS_HOST_POLICY = {
  type: "exact-origin",
  origins: [NALUS_ORIGIN],
} as const;
/** Every NALUS endpoint this adapter reads lives under the search app. */
const NALUS_SEARCH_PATH = "/Search/";
const NALUS_PATH_PREFIXES = [NALUS_SEARCH_PATH] as const;

/**
 * Where the court sends a client that has spent its budget. The page states
 * the limit; the redirect to it is what the crawl sees first.
 */
const LIMIT_EXCEEDED_PAGE = "limit-exceeded.html";

/**
 * NALUS refused the request because the publisher's own rate limit is spent.
 *
 * Distinct from a transport failure on purpose: no retry clears it, and the
 * budget the halt protects is the same budget a retry would spend.
 */
export class NalusRateLimitedError extends TaggedError(
  "NalusRateLimitedError",
)<{
  message: string;
  httpStatus: number;
}> {}

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/**
 * Whether the response is the court's rate-limit refusal.
 *
 * A 302 alone is not: the search form answers a valid submit with one. Only
 * the redirect target names the refusal, and 429 states it outright.
 */
const isRateLimitRefusal = (response: Response): boolean => {
  if (response.status === 429) {
    return true;
  }
  if (!isRedirect(response.status)) {
    return false;
  }
  const location = response.headers.get("Location") ?? "";
  const path = location.split("?").at(0)?.split("#").at(0) ?? "";
  return path.toLowerCase().endsWith(LIMIT_EXCEEDED_PAGE);
};

export type NalusRequestInit = {
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  method?: "POST" | undefined;
  signal?: AbortSignal | undefined;
};

type NalusFetch = (
  url: string,
  init?: NalusRequestInit,
) => Promise<Result<Response, NalusRateLimitedError>>;

/**
 * Every NALUS request the adapter makes, behind one publisher gate.
 *
 * The gate is the budget: a call site that reached the court another way
 * would spend requests nothing counts, so the origin and path are pinned
 * here too and a URL outside them is a programming error rather than a
 * fetch. `dependencies` is the gate's own seam, for exercising the
 * reservation without Redis or a clock.
 */
export const createNalusFetch = (
  dependencies?: PublisherRequestGateDependencies,
): NalusFetch => {
  const reserveSlot = createPublisherSlot(ADAPTER_KEYS.CZ_US, dependencies);
  return async (url, init = {}) => {
    const target = restrictOutboundUrl({
      hostPolicy: NALUS_HOST_POLICY,
      pathPrefixes: NALUS_PATH_PREFIXES,
      rawUrl: url,
    });
    if (target === null) {
      return panic(
        `NALUS request escaped the publisher origin or path: ${url}`,
      );
    }
    // Rebuilt from the fixed origin and search path rather than sent as
    // parsed: a `sourceUrl` replayed from storage reaches this function, and
    // nothing it carries may decide where the request goes.
    const endpoint = new URL(
      `/Search/${target.pathname.slice(NALUS_SEARCH_PATH.length)}${target.search}`,
      NALUS_ORIGIN,
    );
    await reserveSlot(init.signal);
    const response = await fetchWithTimeout(endpoint, {
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: { "User-Agent": INGESTION_USER_AGENT, ...init.headers },
      ...(init.method === undefined ? {} : { method: init.method }),
      // Manual: the court states its refusal as a redirect, and a followed
      // one would be parsed as a search answer.
      redirect: "manual",
      signal: init.signal,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    });
    if (isRateLimitRefusal(response)) {
      return Result.err(
        new NalusRateLimitedError({
          message: `NALUS rate limit reached: the court allows automated clients ${NALUS_DAILY_REQUEST_LIMIT} requests per day`,
          httpStatus: response.status,
        }),
      );
    }
    return Result.ok(response);
  };
};

export const fetchNalus = createNalusFetch();
