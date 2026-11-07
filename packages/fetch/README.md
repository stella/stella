# `@stll/fetch`

`fetch` with a timeout you cannot forget, plus transport-failure helpers.

## `fetchWithTimeout`

```ts
import { fetchWithTimeout } from "@stll/fetch";
import { readBodyWithIdleDeadline } from "@stll/fetch/body-reader";

// Abort when no response headers arrive within 5 seconds.
const response = await fetchWithTimeout(url, {
  timeout: { type: "headers", ms: 5_000 },
});

// Bound headers separately, then observe chunks in the caller's own read.
const download = await fetchWithTimeout(url, {
  timeout: { type: "headers", ms: 10_000 },
  signal: controller.signal, // optional; either signal aborts the request
});
const bytes = await readBodyWithIdleDeadline(download, {
  idleMs: 10_000,
  signal: controller.signal,
});
```

The timeout is required by the type. `headers` bounds only the wait for the
response; `total` bounds the request and its body consumption through the
transport's own signal. Both policies return the transport's response
unchanged. `readBodyWithIdleDeadline` consumes the caller's own body reader,
restarts its deadline after every chunk, and cancels a stalled body with a
`TimeoutError` `DOMException`. The caller's `signal` and a `Request`'s own
signal still abort the request.
`timeoutMs: number` remains the legacy numeric form of the total policy.

`createFetchWithTimeout(fetcher)` returns the same function over another
`fetch` implementation (a proxy-aware client, or a fake in tests).

`isConnectionFailure(error)` reports whether an error, or any error in its
`cause` chain, is a connection-level failure (refused, reset, DNS, TLS
certificate, socket and connect timeouts) across Bun, Node and undici.

## `@stll/fetch/publisher`

This entry needs Bun: it waits between requests with `Bun.sleep`.

`createPolitePublisherFetch({ validateTarget, fetcher })` fetches from public
websites politely: it reads and caches each origin's `robots.txt`, honours
`Disallow` and `Crawl-delay` rules, spaces requests per origin, follows at most
five redirects (validating each hop with `validateTarget`), and returns refusals
as typed `better-result` errors. Requests identify as
`Stella/1.0 (+https://stll.app)`, the product token its robots evaluation
uses. `readBoundedBody(response, { maxBytes, signal })` reads a body with a
size cap.
