import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";

import { fetchStreamFollowingRedirects } from "@/api/lib/redirect-fetch";
import {
  fetchStreamWithResolvedAddress,
  fetchWithResolvedAddress,
  OUTBOUND_IPV6_POLICY,
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

  test("falls back when the first resolved address is unreachable", async () => {
    await withHttpServer(
      (_request, response) => {
        response.end("ready");
      },
      async (port) => {
        const result = await fetchWithResolvedAddress({
          addresses: [
            { address: "::1", family: 6 },
            { address: "127.0.0.1", family: 4 },
          ],
          maxBytes: 1024,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/probe`),
        });

        expect(Result.isOk(result)).toBe(true);
        if (Result.isError(result)) {
          throw result.error;
        }
        expect(new TextDecoder().decode(result.value.body)).toBe("ready");
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

  test("aborts a byte response that stops sending its body", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(200);
        response.write("partial");
      },
      async (port) => {
        const controller = new AbortController();
        const pending = fetchWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          signal: controller.signal,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/stalled`),
        });
        setTimeout(() => {
          controller.abort();
        }, 10);
        const result = await pending;
        expect(Result.isError(result)).toBe(true);
      },
    );
  });

  test("rejects pre-aborted byte and stream requests without an unhandled error", async () => {
    await withHttpServer(
      (_request, response) => {
        response.end("unexpected");
      },
      async (port) => {
        const controller = new AbortController();
        const abortReason = new Error("pre-aborted");
        controller.abort(abortReason);
        for (const fetch of [
          fetchWithResolvedAddress,
          fetchStreamWithResolvedAddress,
        ]) {
          const result = await fetch({
            addresses: [{ address: "127.0.0.1", family: 4 }],
            maxBytes: 1024,
            signal: controller.signal,
            timeoutMs: 1000,
            url: new URL(`http://example.test:${port}/pre-aborted`),
          });
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.cause).toBe(abortReason);
          }
        }
      },
    );
  });

  test("stream redirects remain refused unless manual handling is requested", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(302, { Location: "/target" });
        response.end();
      },
      async (port) => {
        const options = {
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/redirect`),
        } as const;
        const refused = await fetchStreamWithResolvedAddress(options);
        expect(refused.isErr()).toBe(true);
        if (refused.isErr()) {
          expect(refused.error.message).toBe("Redirects are not allowed");
        }
        const manual = await fetchStreamWithResolvedAddress({
          ...options,
          redirect: "manual",
        });
        const response = manual.unwrap();
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/target");
        await response.body.cancel();
      },
    );
  });

  test("revalidates streamed redirect targets before another connection", async () => {
    for (const location of [
      "https://127.0.0.1/private?token=secret",
      "http://publisher.test/plaintext",
      "https://name:secret@publisher.test/file",
      "https://publisher.test/file#fragment",
    ]) {
      let connections = 0;
      await withHttpServer(
        (_request, response) => {
          connections += 1;
          response.writeHead(302, { Location: location });
          response.write("redirect body remains open");
        },
        async (port) => {
          const result = await fetchStreamFollowingRedirects({
            url: "https://publisher.test/file",
            maxHops: 4,
            fetchStream: async (target) => {
              const validated = await validateOutboundFetchTarget(target, {
                resolveAddresses: async () =>
                  Result.ok([{ address: "93.184.216.34", family: 4 }]),
              });
              if (validated.isErr()) {
                return validated;
              }
              const transportUrl = new URL(validated.value.url);
              transportUrl.protocol = "http:";
              transportUrl.port = String(port);
              return await fetchStreamWithResolvedAddress({
                addresses: [{ address: "127.0.0.1", family: 4 }],
                maxBytes: 1024,
                redirect: "manual",
                timeoutMs: 1000,
                url: transportUrl,
              });
            },
          });
          expect(result.isErr()).toBe(true);
          expect(connections).toBe(1);
          if (result.isErr()) {
            expect(result.error.message).not.toContain("secret");
          }
        },
      );
    }
  });

  test("a shared abort signal bounds the final body after streamed redirects", async () => {
    await withHttpServer(
      (request, response) => {
        if (request.url === "/start") {
          response.writeHead(302, { Location: "/stalled" });
          response.write("redirect");
          return;
        }
        response.writeHead(200);
        response.write("partial");
      },
      async (port) => {
        const controller = new AbortController();
        const abortReason = new Error("shared deadline reached");
        const result = await fetchStreamFollowingRedirects({
          url: `http://publisher.test:${port}/start`,
          maxHops: 4,
          fetchStream: async (target) =>
            await fetchStreamWithResolvedAddress({
              addresses: [{ address: "127.0.0.1", family: 4 }],
              maxBytes: 1024,
              redirect: "manual",
              signal: controller.signal,
              timeoutMs: 1000,
              url: new URL(target),
            }),
        });
        const reader = result.unwrap().body.getReader();
        expect((await reader.read()).done).toBe(false);
        const pendingRead = reader.read();
        controller.abort(abortReason);
        const read = await Result.tryPromise(async () => await pendingRead);
        expect(read.isErr()).toBe(true);
        reader.releaseLock();
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

  test("streams through a reachable fallback address", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("event: ping\ndata: ready\n\n");
      },
      async (port) => {
        const result = await fetchStreamWithResolvedAddress({
          addresses: [
            { address: "::1", family: 6 },
            { address: "127.0.0.1", family: 4 },
          ],
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

  test("applies the IPv6 address policy", () => {
    const policyForAddress = (address: bigint) =>
      OUTBOUND_IPV6_POLICY.filter(
        ({ prefix, length }) =>
          address >= prefix && address < prefix + 2n ** BigInt(128 - length),
      )
        .toSorted((left, right) => right.length - left.length)
        .at(0);
    const urlForAddress = (address: bigint): string => {
      const hexadecimal = address.toString(16).padStart(32, "0");
      const host = Array.from({ length: 8 }, (_, index) =>
        hexadecimal.slice(index * 4, index * 4 + 4),
      ).join(":");
      return `https://[${host}]/`;
    };

    for (const { prefix, length, verdict } of OUTBOUND_IPV6_POLICY) {
      if (verdict !== "block" && verdict !== "allow") {
        continue;
      }
      const size = 2n ** BigInt(128 - length);
      const addresses = new Set([
        prefix - 1n,
        prefix,
        prefix + 1n,
        prefix + size - 1n,
        prefix + size,
      ]);
      let checked = 0;
      for (const address of addresses) {
        if (address < 0n || address >= 2n ** 128n) {
          continue;
        }
        const effective = policyForAddress(address);
        if (
          effective !== undefined &&
          effective.verdict !== "block" &&
          effective.verdict !== "allow"
        ) {
          continue;
        }
        expect(Result.isOk(parseSafeOutboundUrl(urlForAddress(address)))).toBe(
          effective === undefined || effective.verdict === "allow",
        );
        checked += 1;
      }
      expect(checked).toBeGreaterThan(0);
    }

    for (const host of ["100:0:0:2::", "2001:200::", "3fff:1000::"]) {
      expect(Result.isOk(parseSafeOutboundUrl(`https://[${host}]/`))).toBe(
        true,
      );
    }
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
  test("applies the request timeout while DNS resolution is pending", async () => {
    const result = await validateOutboundFetchTarget(
      "https://example.com/skill.md",
      {
        resolveAddresses: async () =>
          await new Promise(() => {
            // Intentionally never resolves: the validation deadline must win.
          }),
        timeoutMs: 5,
      },
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected DNS validation to time out");
    }
    expect(result.error.message).toBe("Request timed out");
  });

  test("aborts while DNS resolution is pending", async () => {
    const controller = new AbortController();
    const pending = validateOutboundFetchTarget(
      "https://example.com/skill.md",
      {
        resolveAddresses: async () =>
          await new Promise(() => {
            // The abort must settle validation while DNS is still pending.
          }),
        signal: controller.signal,
        timeoutMs: 1000,
      },
    );
    controller.abort();
    expect(Result.isError(await pending)).toBe(true);
  });

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

    // oxlint-disable-next-line node/callback-return -- callback returns void; returning it trips no-confusing-void-expression, and the finally block runs cleanup after it resolves
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
