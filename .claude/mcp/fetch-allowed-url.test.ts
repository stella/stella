import { describe, expect, test } from "bun:test";

import { fetchAllowedUrl } from "./fetch-allowed-url";

const allowedHosts = new Set(["docs.example"]);

describe("fetchAllowedUrl", () => {
  test("follows redirects that stay on allowlisted HTTPS hosts", async () => {
    const acceptHeaders: (string | null)[] = [];
    const result = await fetchAllowedUrl({
      allowedHosts,
      fetchImpl: async (input, init) => {
        acceptHeaders.push(new Headers(init?.headers).get("accept"));
        const url = new URL(input.toString());
        if (url.pathname === "/start") {
          return new Response(null, {
            headers: { location: "/target" },
            status: 302,
          });
        }
        return new Response("docs", {
          headers: { "content-type": "text/plain;charset=utf-8" },
        });
      },
      url: "https://docs.example/start",
    });

    expect(result).toEqual({
      contentType: "text/plain;charset=utf-8",
      text: "docs",
      url: "https://docs.example/target",
    });
    expect(acceptHeaders).toEqual([
      "text/markdown, text/plain;q=0.9, text/html;q=0.5, */*;q=0.1",
      "text/markdown, text/plain;q=0.9, text/html;q=0.5, */*;q=0.1",
    ]);
  });

  test("blocks redirects to non-allowlisted hosts before fetching them", async () => {
    const fetchedUrls: string[] = [];

    await expect(
      fetchAllowedUrl({
        allowedHosts,
        fetchImpl: async (input) => {
          fetchedUrls.push(input.toString());
          return new Response(null, {
            headers: { location: "https://127.0.0.1/secret" },
            status: 302,
          });
        },
        url: "https://docs.example/start",
      }),
    ).rejects.toThrow("Blocked: 127.0.0.1 is not a configured doc source");

    expect(fetchedUrls).toEqual(["https://docs.example/start"]);
  });

  test("applies one timeout budget across redirects", async () => {
    const signals: AbortSignal[] = [];

    await fetchAllowedUrl({
      allowedHosts,
      fetchImpl: async (_input, init) => {
        if (init?.signal instanceof AbortSignal) {
          signals.push(init.signal);
        }

        if (signals.length === 1) {
          return new Response(null, {
            headers: { location: "/target" },
            status: 302,
          });
        }

        return new Response("docs");
      },
      url: "https://docs.example/start",
    });

    expect(signals).toHaveLength(2);
    expect(signals.at(0)).toBe(signals.at(1));
  });

  test("rejects responses with oversized content-length", async () => {
    await expect(
      fetchAllowedUrl({
        allowedHosts,
        fetchImpl: async () =>
          new Response("small", {
            headers: { "content-length": "10" },
          }),
        maxResponseBytes: 4,
        url: "https://docs.example/start",
      }),
    ).rejects.toThrow("Documentation response exceeds size limit");
  });

  test("rejects streamed responses that exceed the byte limit", async () => {
    await expect(
      fetchAllowedUrl({
        allowedHosts,
        fetchImpl: async () => new Response("toolong"),
        maxResponseBytes: 4,
        url: "https://docs.example/start",
      }),
    ).rejects.toThrow("Documentation response exceeds size limit");
  });
});
