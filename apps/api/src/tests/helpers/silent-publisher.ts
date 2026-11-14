import {
  fetchWithResolvedAddress,
  type safeOutboundFetchBytes,
} from "@/api/lib/auth/authorized-outbound-fetch";

/**
 * A local publisher that accepts every request and never answers it: no
 * status line, no headers, no bytes. Requests reach it over the real outbound
 * transport, which enforces its own time limit; the caller's limit is recorded
 * and replaced by a short one so a test does not wait out the real one.
 */
export const createSilentPublisher = ({ timeoutMs }: { timeoutMs: number }) => {
  const received: string[] = [];
  const requested: { url: string; timeoutMs: number | undefined }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(new URL(request.url).pathname);
      // Holds the request open until the client gives up on it.
      await new Promise((resolve) => {
        request.signal.addEventListener("abort", resolve, { once: true });
      });
      return new Response(null, { status: 504 });
    },
  });
  const fetchBytesRequest: typeof safeOutboundFetchBytes = async (options) => {
    const url = new URL(options.url);
    requested.push({
      url: url.href,
      timeoutMs: options.timeoutMs,
    });
    const transportUrl = new URL(url);
    transportUrl.protocol = "http:";
    transportUrl.port = String(server.port);
    return await fetchWithResolvedAddress({
      permit: options.permit,
      url: transportUrl,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      maxBytes: options.maxBytes,
      headers: options.headers,
      signal: options.signal,
      timeoutMs,
    });
  };
  return {
    fetchBytesRequest,
    received: () => [...received],
    requested: () => [...requested],
    stop: async () => {
      await server.stop(true);
    },
  };
};
