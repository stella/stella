import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";

import {
  fetchStreamWithResolvedAddress,
  fetchWithResolvedAddress,
  parseSafeOutboundUrl,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";

describe("fetchWithResolvedAddress", () => {
  test("connects to the pre-resolved address while preserving the URL host", async () => {
    await withHttpServer(
      (request, response) => {
        response.end(request.headers.host ?? "");
      },
      async (port) => {
        const result = await fetchWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/probe`),
        });

        expect(Result.isOk(result)).toBe(true);
        if (Result.isError(result)) {
          throw result.error;
        }

        expect(new TextDecoder().decode(result.value.body)).toBe(
          `example.test:${port}`,
        );
      },
    );
  });

  test("stops reading when the response exceeds the byte cap", async () => {
    await withHttpServer(
      (_request, response) => {
        response.end("0123456789");
      },
      async (port) => {
        const result = await fetchWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 4,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/large`),
        });

        expect(Result.isError(result)).toBe(true);
      },
    );
  });

  test("rejects redirects by default", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(302, { Location: "/target" });
        response.end();
      },
      async (port) => {
        const result = await fetchWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/redirect`),
        });

        expect(Result.isError(result)).toBe(true);
      },
    );
  });

  test("can return redirects for callers that revalidate each hop", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(302, { Location: "/target" });
        response.end();
      },
      async (port) => {
        const result = await fetchWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          redirect: "manual",
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/redirect`),
        });

        expect(Result.isOk(result)).toBe(true);
        if (Result.isError(result)) {
          throw result.error;
        }

        expect(result.value.status).toBe(302);
        expect(result.value.headers.get("location")).toBe("/target");
      },
    );
  });

  test("returns streaming responses before the server closes the body", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("event: ping\ndata: ready\n\n");
      },
      async (port) => {
        const result = await fetchStreamWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/events`),
        });

        expect(Result.isOk(result)).toBe(true);
        if (Result.isError(result)) {
          throw result.error;
        }

        const reader = result.value.body.getReader();
        const firstChunk = await reader.read();
        await reader.cancel();

        expect(firstChunk.done).toBe(false);
        expect(new TextDecoder().decode(firstChunk.value)).toContain(
          "data: ready",
        );
      },
    );
  });
});

describe("parseSafeOutboundUrl", () => {
  test("accepts an https public hostname", () => {
    expect(Result.isOk(parseSafeOutboundUrl("https://api.openai.com/v1"))).toBe(
      true,
    );
  });

  test("rejects http (non-HTTPS)", () => {
    expect(
      Result.isError(parseSafeOutboundUrl("http://api.openai.com/v1")),
    ).toBe(true);
  });

  test("rejects unknown schemes", () => {
    expect(Result.isError(parseSafeOutboundUrl("ftp://example.com"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("file:///etc/passwd"))).toBe(
      true,
    );
  });

  test("rejects malformed and empty URLs", () => {
    expect(Result.isError(parseSafeOutboundUrl("not-a-url"))).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl(""))).toBe(true);
  });

  test("rejects URLs with embedded credentials", () => {
    expect(
      Result.isError(parseSafeOutboundUrl("https://user:pass@example.com/v1")),
    ).toBe(true);
  });

  test("rejects URLs with a hash fragment", () => {
    expect(
      Result.isError(parseSafeOutboundUrl("https://example.com/v1#frag")),
    ).toBe(true);
  });

  test("rejects localhost variants", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://localhost/v1"))).toBe(
      true,
    );
    expect(
      Result.isError(parseSafeOutboundUrl("https://api.localhost/v1")),
    ).toBe(true);
    expect(
      Result.isError(parseSafeOutboundUrl("https://service.local/v1")),
    ).toBe(true);
    expect(
      Result.isError(parseSafeOutboundUrl("https://api.internal/v1")),
    ).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl("https://app.corp/v1"))).toBe(
      true,
    );
  });

  test("rejects IPv4 loopback", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://127.0.0.1/v1"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("https://127.1.2.3/v1"))).toBe(
      true,
    );
  });

  test("rejects AWS metadata service (link-local)", () => {
    expect(
      Result.isError(parseSafeOutboundUrl("https://169.254.169.254/")),
    ).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl("https://169.254.0.1/"))).toBe(
      true,
    );
  });

  test("rejects RFC1918 private ranges", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://10.0.0.1/v1"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("https://172.16.0.1/v1"))).toBe(
      true,
    );
    expect(
      Result.isError(parseSafeOutboundUrl("https://172.31.255.255/v1")),
    ).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl("https://192.168.1.1/v1"))).toBe(
      true,
    );
  });

  test("rejects 0.0.0.0/8 and CGNAT", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://0.0.0.0/v1"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("https://100.64.0.1/v1"))).toBe(
      true,
    );
  });

  test("rejects multicast and reserved ranges", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://224.0.0.1/v1"))).toBe(
      true,
    );
    expect(
      Result.isError(parseSafeOutboundUrl("https://239.255.255.255/v1")),
    ).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl("https://240.0.0.1/v1"))).toBe(
      true,
    );
    expect(
      Result.isError(parseSafeOutboundUrl("https://255.255.255.255/v1")),
    ).toBe(true);
  });

  test("rejects test/documentation IPv4 ranges", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://192.0.2.1/v1"))).toBe(
      true,
    );
    expect(
      Result.isError(parseSafeOutboundUrl("https://198.51.100.1/v1")),
    ).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl("https://203.0.113.1/v1"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("https://198.18.0.1/v1"))).toBe(
      true,
    );
  });

  test("accepts public IPv4", () => {
    expect(Result.isOk(parseSafeOutboundUrl("https://8.8.8.8/v1"))).toBe(true);
    expect(Result.isOk(parseSafeOutboundUrl("https://1.1.1.1/v1"))).toBe(true);
  });

  test("rejects IPv6 loopback and unspecified", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://[::1]/v1"))).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl("https://[::]/v1"))).toBe(true);
  });

  test("rejects IPv6 link-local fe80::/10", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://[fe80::1]/v1"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("https://[febf::1]/v1"))).toBe(
      true,
    );
  });

  test("rejects IPv6 ULA fc00::/7", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://[fc00::1]/v1"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("https://[fd00::1]/v1"))).toBe(
      true,
    );
  });

  test("rejects IPv6 multicast ff00::/8", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://[ff02::1]/v1"))).toBe(
      true,
    );
  });

  test("rejects IPv4-mapped IPv6 to loopback", () => {
    expect(
      Result.isError(parseSafeOutboundUrl("https://[::ffff:127.0.0.1]/v1")),
    ).toBe(true);
    expect(
      Result.isError(
        parseSafeOutboundUrl("https://[::ffff:169.254.169.254]/v1"),
      ),
    ).toBe(true);
  });

  test("rejects IPv6 documentation, benchmarking, and discard ranges", () => {
    expect(
      Result.isError(parseSafeOutboundUrl("https://[2001:db8::1]/v1")),
    ).toBe(true);
    expect(Result.isError(parseSafeOutboundUrl("https://[2001:2::1]/v1"))).toBe(
      true,
    );
    expect(Result.isError(parseSafeOutboundUrl("https://[100::1]/v1"))).toBe(
      true,
    );
  });

  test("does not over-block IPv6 hextets shorter than four hex digits", () => {
    expect(Result.isOk(parseSafeOutboundUrl("https://[fe8::1]/v1"))).toBe(true);
    expect(Result.isOk(parseSafeOutboundUrl("https://[ff::1]/v1"))).toBe(true);
  });

  test("rejects trailing-dot variants of blocked hostnames", () => {
    expect(Result.isError(parseSafeOutboundUrl("https://localhost./v1"))).toBe(
      true,
    );
    expect(
      Result.isError(parseSafeOutboundUrl("https://service.local./v1")),
    ).toBe(true);
    expect(
      Result.isError(parseSafeOutboundUrl("https://api.internal./v1")),
    ).toBe(true);
  });

  test("rejects URLs longer than the outbound length limit", () => {
    const longUrl = `https://example.com/${"x".repeat(3000)}`;
    expect(Result.isError(parseSafeOutboundUrl(longUrl))).toBe(true);
  });
});

describe("validateOutboundFetchTarget", () => {
  test("rejects an IP-literal private host before any DNS lookup", async () => {
    const result = await validateOutboundFetchTarget("https://127.0.0.1/x");
    expect(Result.isError(result)).toBe(true);
  });

  test("rejects an IP-literal AWS metadata host", async () => {
    const result = await validateOutboundFetchTarget(
      "https://169.254.169.254/",
    );
    expect(Result.isError(result)).toBe(true);
  });

  test("accepts an IP-literal public host and returns the resolved address", async () => {
    const result = await validateOutboundFetchTarget("https://8.8.8.8/v1");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(result.value.url.hostname).toBe("8.8.8.8");
  });

  test("accepts a bracketed public IPv6 literal and returns a bare resolved address", async () => {
    const result = await validateOutboundFetchTarget(
      "https://[2606:4700:4700::1111]/v1",
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value.addresses).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });
});

const withHttpServer = async (
  handler: RequestListener,
  callback: (port: number) => Promise<void>,
): Promise<void> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
};
