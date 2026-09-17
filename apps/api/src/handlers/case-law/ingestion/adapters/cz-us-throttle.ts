import { panic, TaggedError } from "better-result";

import { DAY_IN_MS } from "@stll/time";

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import {
  createPublisherRequestSlot,
  type PublisherRequestGateDependencies,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

/**
 * The ceiling nalus.usoud.cz states to an over-quota client: "The maximum
 * allowed limit for automated scrapers is 5,000 requests per day."
 */
export const NALUS_DAILY_REQUEST_LIMIT = 5000;

/** The share of the stated limit this worker spends; the rest is margin. */
const NALUS_REQUEST_BUDGET_SHARE = 0.96;

/**
 * One NALUS request per interval, across every loop in every process that
 * talks to the court: 4,800 requests a day against the 5,000 it allows.
 */
export const NALUS_REQUEST_INTERVAL_MS = Math.ceil(
  DAY_IN_MS / (NALUS_DAILY_REQUEST_LIMIT * NALUS_REQUEST_BUDGET_SHARE),
);

const NALUS_GATE_CONFIG = {
  intervalMs: NALUS_REQUEST_INTERVAL_MS,
  key: "case-law:publisher-gate:nalus-usoud",
  publisher: "NALUS",
} as const;

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

type NalusRequestInit = {
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  method?: "POST" | undefined;
  signal?: AbortSignal | undefined;
};

type NalusFetch = (url: string, init?: NalusRequestInit) => Promise<Response>;

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
  const reserveSlot = createPublisherRequestSlot(
    NALUS_GATE_CONFIG,
    dependencies,
  );
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
      throw new NalusRateLimitedError({
        message: `NALUS rate limit reached: the court allows automated clients ${NALUS_DAILY_REQUEST_LIMIT} requests per day`,
        httpStatus: response.status,
      });
    }
    return response;
  };
};

export const fetchNalus = createNalusFetch();
