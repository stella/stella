import { describe, expect, test } from "bun:test";

import {
  createSearchCrawlerVerifier,
  isVerifiedSearchCrawler,
} from "./verified-search-crawler";

describe("search crawler identity", () => {
  test("DNS failures deny the exemption and are retried after the negative cache expires", async () => {
    let now = 0;
    let queries = 0;
    const verify = createSearchCrawlerVerifier({
      now: () => now,
      dns: {
        reverse: async () => {
          queries += 1;
          throw new TypeError("DNS unavailable");
        },
        resolve4: async () => [],
        resolve6: async () => [],
      },
    });
    expect(await verify("66.249.66.1")).toBe(false);
    expect(await verify("66.249.66.1")).toBe(false);
    expect(queries).toBe(1);
    now = 60_000;
    expect(await verify("66.249.66.1")).toBe(false);
    expect(queries).toBe(2);
  });
  test.each([
    { host: "crawl.googlebot.com", forward: "66.249.66.1", verified: true },
    { host: "crawl.search.msn.com", forward: "66.249.66.1", verified: true },
    {
      host: "crawl.googlebot.com.attacker.example",
      forward: "66.249.66.1",
      verified: false,
    },
    { host: "attackergooglebot.com", forward: "66.249.66.1", verified: false },
    { host: "crawl.googlebot.com", forward: "192.0.2.1", verified: false },
  ])(
    "requires provider domain and matching forward address: $host $forward",
    async ({ host, forward, verified }) => {
      const verify = createSearchCrawlerVerifier({
        dns: {
          reverse: async () => [host],
          resolve4: async () => [forward],
          resolve6: async () => [],
        },
      });
      expect(await verify("66.249.66.1")).toBe(verified);
    },
  );

  test("confirms full IPv6 addresses rather than their rate-limit subnet", async () => {
    const verify = createSearchCrawlerVerifier({
      dns: {
        reverse: async () => ["crawl.googlebot.com"],
        resolve4: async () => [],
        resolve6: async () => ["2001:4860:4801:1::1"],
      },
    });
    expect(await verify("2001:4860:4801:1:0:0:0:1")).toBe(true);
    expect(await verify("2001:4860:4801:1::2")).toBe(false);
  });

  test("coalesces concurrent DNS work and expires successful identity checks", async () => {
    let now = 0;
    let queries = 0;
    const verify = createSearchCrawlerVerifier({
      now: () => now,
      dns: {
        reverse: async () => {
          queries += 1;
          return ["crawl.googlebot.com"];
        },
        resolve4: async () => ["66.249.66.1"],
        resolve6: async () => [],
      },
    });
    expect(
      await Promise.all(
        Array.from({ length: 10 }, () => verify("66.249.66.1")),
      ),
    ).toEqual(Array.from({ length: 10 }, () => true));
    expect(queries).toBe(1);
    now = 60 * 60 * 1000;
    expect(await verify("66.249.66.1")).toBe(true);
    expect(queries).toBe(2);
  });

  test("a crawler UA and a spoofed forwarded address do not verify the socket peer", async () => {
    const addresses: string[] = [];
    const verified = await isVerifiedSearchCrawler({
      request: new Request("http://localhost/v1/case/sitemap/shards", {
        headers: {
          "user-agent": "Googlebot",
          "x-forwarded-for": "66.249.66.1",
        },
      }),
      server: { requestIP: () => ({ address: "192.0.2.1" }) },
      verifyAddress: async (address) => {
        addresses.push(address);
        return address === "66.249.66.1";
      },
    });
    expect(verified).toBe(false);
    expect(addresses).toEqual(["192.0.2.1"]);
  });
});
