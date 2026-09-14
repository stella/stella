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
