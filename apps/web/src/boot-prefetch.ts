/**
 * Boot-time auth prefetch.
 *
 * Loaded from index.html as its own module script, BEFORE the main
 * application graph. Its import graph is deliberately tiny (env resolution
 * only), so the two auth requests every protected route blocks on —
 * `GET /get-session` and `GET /organization/get-active-member-role` — leave
 * the browser while the multi-megabyte route graph is still downloading,
 * instead of after the router has booted (measured ~850ms later in prod).
 *
 * The auth client does not fetch these itself when a prefetch is pending:
 * its `customFetchImpl` (see `lib/auth.ts`) calls `takeBootPrefetch` and
 * serves the prefetched Response for the first matching GET. This module is
 * the single sanctioned place for boot-critical prefetches; anything else
 * belongs in route loaders (`ensureRouteQueryData`), where the network
 * baseline's waterfall-depth budget guards it.
 *
 * Staleness guards, in both directions:
 * - consume-once: each Response is handed out at most once, then the slot
 *   clears, so a post-sign-in `getSession` can never see pre-sign-in data
 *   twice.
 * - TTL: a slot older than `BOOT_PREFETCH_TTL_MS` is ignored. The consumer
 *   normally arrives within a couple of seconds of boot; a much later first
 *   read means the boot path was interrupted (long auth screen, bfcache
 *   restore) and fresh data is worth one round trip.
 * - mutation fence: `discardBootPrefetch` drops every pending slot; the auth
 *   client calls it for any non-GET auth request (sign-in, sign-out, org
 *   switch), so no prefetched response can survive an auth state change.
 */

import { browserAuthBaseUrl } from "@/lib/api-origins";

export const BOOT_PREFETCH_PATHS = [
  "/get-session",
  "/organization/get-active-member-role",
] as const;

type BootPrefetchPath = (typeof BOOT_PREFETCH_PATHS)[number];

type PrefetchSlot = {
  controller: AbortController;
  generation: number;
  startedAt: number;
  response: Promise<Response | null>;
};

const BOOT_PREFETCH_TTL_MS = 30_000;

// Matches the auth client's own AUTH_REQUEST_TIMEOUT_MS bound. Without it a
// stalled prefetch would hang the consumer: `takeBootPrefetch` awaits the
// slot's promise, bypassing the auth client's fetchWithTimeout fallback, and
// the TTL is checked before the await so it cannot release the wait.
const BOOT_PREFETCH_TIMEOUT_MS = 8000;

const slots = new Map<BootPrefetchPath, PrefetchSlot>();
let prefetchGeneration = 0;

/**
 * Consume the prefetched Response for an auth request, or null when there is
 * nothing usable (no prefetch ran, already consumed, expired, or the request
 * is not one of the two boot paths). `pathname` is matched on its suffix so
 * both the bare API origin and the `/api/auth`-mounted browser path resolve.
 */
export const takeBootPrefetch = async (
  pathname: string,
): Promise<Response | null> => {
  const path = BOOT_PREFETCH_PATHS.find((candidate) =>
    pathname.endsWith(candidate),
  );
  if (path === undefined) {
    return null;
  }
  const slot = slots.get(path);
  if (slot === undefined) {
    return null;
  }
  slots.delete(path);
  if (Date.now() - slot.startedAt > BOOT_PREFETCH_TTL_MS) {
    return null;
  }
  const response = await slot.response;
  if (
    slot.generation !== prefetchGeneration ||
    slot.controller.signal.aborted
  ) {
    return null;
  }
  return response;
};

/** Drop every pending prefetch. Called on any auth mutation so a stale
 *  pre-mutation response can never satisfy a post-mutation read. */
export const discardBootPrefetch = (): void => {
  prefetchGeneration += 1;
  for (const { controller } of slots.values()) {
    controller.abort();
  }
  slots.clear();
};

/**
 * The method that decides between consuming a prefetch (GET) and fencing it
 * (mutation). A `Request` input carries its own method, which `init` may
 * omit entirely; missing that would let a POST slip past the mutation fence
 * and a later GET consume stale pre-mutation data.
 */
export const resolveRequestMethod = (
  input: string | URL | Request,
  init: RequestInit | undefined,
): string =>
  (
    init?.method ??
    (input instanceof Request ? input.method : undefined) ??
    "GET"
  ).toUpperCase();

/** Structural fetch subset so the unit test can pass a plain function
 *  without casting to the full (Bun-extended) fetch type. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ReportPrefetchError = (error: unknown) => Promise<void>;

const reportPrefetchError: ReportPrefetchError = async (error) => {
  const { getAnalytics } = await import("@/lib/analytics/provider");
  getAnalytics().captureError(error);
};

type StartBootPrefetchOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  reportError?: ReportPrefetchError;
};

/** Exported for the unit test only; the module fires it at evaluation time
 *  in the browser (guard below). */
export const startBootPrefetch = ({
  fetchImpl = fetch,
  now = Date.now,
  reportError = reportPrefetchError,
}: StartBootPrefetchOptions = {}): void => {
  // A second boot attempt supersedes, cancels, and invalidates every response
  // from the first one. This also keeps test and bfcache re-entry behavior
  // equivalent to the single browser-module evaluation.
  discardBootPrefetch();
  const generation = prefetchGeneration;
  const controller = new AbortController();
  const base = `${browserAuthBaseUrl()}/api/auth`;
  // A transport failure resolves to null: the consumer falls back to its
  // own (retrying, timeout-bounded) fetch instead of inheriting an
  // unbounded prefetch rejection. The capture import is dynamic so the
  // analytics graph never rides in this deliberately tiny boot chunk; it
  // only loads on the failure path. Reporting stays best-effort: a telemetry
  // failure must never prevent the normal bounded auth request fallback.
  const reportAndDrop = async (error: unknown): Promise<null> => {
    if (controller.signal.aborted) {
      return null;
    }
    try {
      await reportError(error);
    } catch {
      // The reporting path itself failed; the auth client must still perform
      // its normal fallback request instead of inheriting telemetry failure.
    }
    return null;
  };
  const requestSignal = (): AbortSignal =>
    AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(BOOT_PREFETCH_TIMEOUT_MS),
    ]);
  const sessionResponse = fetchImpl(`${base}/get-session`, {
    credentials: "include",
    headers: { accept: "application/json" },
    signal: requestSignal(),
  }).catch(reportAndDrop);
  slots.set("/get-session", {
    controller,
    generation,
    startedAt: now(),
    response: sessionResponse,
  });
  // The member-role request is chained, not parallel: anonymous visitors get
  // a 401 and org-less sessions a 400, both of which the browser reports as
  // console errors on every public-page boot. Reading the session response
  // first costs one round trip of latency only for signed-in users, and both
  // requests still finish while the route graph is downloading.
  slots.set("/organization/get-active-member-role", {
    startedAt: now(),
    controller,
    generation,
    response: sessionResponse
      .then(async (response) => {
        if (
          controller.signal.aborted ||
          generation !== prefetchGeneration ||
          response === null ||
          !response.ok
        ) {
          return null;
        }
        const body: unknown = await response.clone().json();
        const hasActiveOrganization =
          typeof body === "object" &&
          body !== null &&
          "session" in body &&
          typeof body.session === "object" &&
          body.session !== null &&
          "activeOrganizationId" in body.session &&
          typeof body.session.activeOrganizationId === "string";
        if (!hasActiveOrganization) {
          return null;
        }
        return await fetchImpl(`${base}/organization/get-active-member-role`, {
          credentials: "include",
          headers: { accept: "application/json" },
          signal: requestSignal(),
        });
      })
      .catch(reportAndDrop),
  });
};

// Module scripts never execute during SSR, but the main graph also imports
// this module for `takeBootPrefetch`; the guard keeps a server evaluation
// from firing browser fetches.
if (typeof document !== "undefined") {
  startBootPrefetch();
}
