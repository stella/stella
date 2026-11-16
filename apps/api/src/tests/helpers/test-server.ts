import type { HttpApp } from "@/api/http/app";

// The network fetch as it is when this module loads. A test that replaces the
// global `fetch` (to serve an outbound client in process) must still reach the
// server over the network; calling the replaced global here would hand the
// request straight back to the test's own stub, which forwards it here again.
const networkFetch = globalThis.fetch;

export type TestServer = {
  readonly url: URL;
  /**
   * Send a request to the running server. The request's own origin is
   * replaced, so tests can keep writing `new Request("http://localhost/x")`.
   */
  readonly fetch: (
    request: Request | string,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly stop: () => Promise<void>;
} & AsyncDisposable;

/**
 * Serve an app on an ephemeral port with the production `Bun.serve` routing,
 * so a test exercises exactly the router, pipeline and wire format users get.
 */
export const serveForTest = (app: HttpApp): TestServer => {
  const server = Bun.serve({ port: 0, ...app.serveOptions });
  const stop = async () => {
    await server.stop(true);
  };
  return {
    url: server.url,
    fetch: async (input, init) => {
      const request =
        typeof input === "string" ? new Request(input, init) : input;
      const source = new URL(request.url);
      const target = new URL(`${source.pathname}${source.search}`, server.url);
      // The same request, addressed to this server over the network: Bun's
      // `server.fetch` calls only the `fetch` fallback and skips `routes`, so
      // a real request is the one that meets the production router.
      return await networkFetch(
        new Request(target.href, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          redirect: "manual",
        }),
      );
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
};
