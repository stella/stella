/**
 * How a route asks for an SSR document status other than the 200 a rendered
 * match gets.
 *
 * The router derives the HTML status from the match state alone (200 for a
 * rendered page, 404 for a not-found, 500 for a thrown error) and exposes no
 * per-route status. It does merge a route's `headers` into the SSR response,
 * so a route that renders a degraded page states the status it wants there,
 * and the server entry (which owns the final Response) applies it and strips
 * the header before it leaves the process.
 */
export const SSR_STATUS_HEADER = "x-stella-ssr-status";

/** A route's `headers` output, asking for `status` on this document. */
export const ssrStatusHeaders = (status: number): Record<string, string> => ({
  [SSR_STATUS_HEADER]: String(status),
});

const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/**
 * The status a document asked for, or null when it asked for none. A value
 * outside the HTTP range is not a status the `Response` constructor accepts,
 * so it is dropped rather than allowed to throw inside the request path.
 */
export const ssrStatusFromHeader = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }
  const status = Number(value);
  if (
    !Number.isInteger(status) ||
    status < MIN_HTTP_STATUS ||
    status > MAX_HTTP_STATUS
  ) {
    return null;
  }
  return status;
};

/**
 * The status a document is sent with: the one its route asked for, else the
 * router's. The diagnostic report and the response both read it from here, so
 * a degraded page a route serves as 503 is reported as the 503 it sends.
 */
export const documentStatus = (
  headers: Pick<Headers, "get">,
  routerStatus: number,
): number =>
  ssrStatusFromHeader(headers.get(SSR_STATUS_HEADER)) ?? routerStatus;

const ROUTER_ERROR_STATUS = 500;
const RETRYABLE_DOCUMENT_STATUS = 503;

/**
 * How long a client or crawler is told to wait before asking for a document
 * again after a read that asking again fixes.
 */
export const RETRYABLE_DOCUMENT_RETRY_AFTER_SECONDS = 120;

/**
 * Sends a document the router failed with 500 as 503 with `Retry-After`
 * when every loader failure was a read that asking again fixes (the API was
 * busy, slow or unreachable). A 500 tells a crawler the page is broken; a 503
 * tells it to come back. A status the route already asked for stands.
 */
export const markRetryableDocumentFailure = ({
  errors,
  headers,
  isRetryable,
  routerStatus,
}: {
  errors: readonly unknown[];
  headers: Pick<Headers, "has" | "set">;
  isRetryable: (error: unknown) => boolean;
  routerStatus: number;
}): void => {
  if (
    routerStatus !== ROUTER_ERROR_STATUS ||
    headers.has(SSR_STATUS_HEADER) ||
    errors.length === 0 ||
    !errors.every(isRetryable)
  ) {
    return;
  }
  headers.set(SSR_STATUS_HEADER, String(RETRYABLE_DOCUMENT_STATUS));
  headers.set("Retry-After", String(RETRYABLE_DOCUMENT_RETRY_AFTER_SECONDS));
};
