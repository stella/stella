# `@stll/fetch`

`fetch` with a timeout you cannot forget, plus transport-failure helpers.

## `fetchWithTimeout`

```ts
import { fetchWithTimeout } from "@stll/fetch";

// Abort when no response headers arrive within 5 seconds.
const response = await fetchWithTimeout(url, {
  timeout: { type: "headers", ms: 5_000 },
});

// Abort when the headers, or any later body chunk, take longer than
// 10 seconds: a slow but progressing download keeps going.
const stream = await fetchWithTimeout(url, {
  timeout: { type: "idle", ms: 10_000 },
  signal: controller.signal, // optional; either signal aborts the request
});
```

The timeout is required by the type. `headers` bounds the wait for the
response; `idle` also restarts on every body chunk and errors the body stream
when it stalls. A timeout rejects (or errors the body) with a `TimeoutError`
`DOMException`, and the caller's `signal` and a `Request`'s own signal still
abort the request. `timeoutMs: number` is a total deadline over the request
and its body.

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
