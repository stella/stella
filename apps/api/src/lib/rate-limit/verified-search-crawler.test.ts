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
      createDns: () => ({
        reverse: async () => {
          queries += 1;
          throw new TypeError("DNS unavailable");
        },
        resolve4: async () => [],
        resolve6: async () => [],
        cancel: () => {},
      }),
    });
    expect(await verify("66.249.66.1")).toBe(false);
    expect(await verify("66.249.66.1")).toBe(false);
    expect(queries).toBe(1);
    now = 60_000;
    expect(await verify("66.249.66.1")).toBe(false);
    expect(queries).toBe(2);
  });
  test("a provider PTR receives no exemption when forward DNS fails", async () => {
    const verify = createSearchCrawlerVerifier({
      createDns: () => ({
        reverse: async () => ["crawl.googlebot.com"],
        resolve4: async () => {
          throw new TypeError("Forward DNS unavailable");
        },
        resolve6: async () => [],
        cancel: () => {},
      }),
    });
    expect(await verify("66.249.66.1")).toBe(false);
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
        createDns: () => ({
          reverse: async () => [host],
          resolve4: async () => [forward],
          resolve6: async () => [],
          cancel: () => {},
        }),
      });
      expect(await verify("66.249.66.1")).toBe(verified);
    },
  );

  test("confirms full IPv6 addresses rather than their rate-limit subnet", async () => {
    const verify = createSearchCrawlerVerifier({
      createDns: () => ({
        reverse: async () => ["crawl.googlebot.com"],
        resolve4: async () => [],
        resolve6: async () => ["2001:4860:4801:1::1"],
        cancel: () => {},
      }),
    });
    expect(await verify("2001:4860:4801:1:0:0:0:1")).toBe(true);
    expect(await verify("2001:4860:4801:1::2")).toBe(false);
  });

  test("coalesces concurrent DNS work and expires successful identity checks", async () => {
    let now = 0;
    let queries = 0;
    const verify = createSearchCrawlerVerifier({
      now: () => now,
      createDns: () => ({
        reverse: async () => {
          queries += 1;
          return ["crawl.googlebot.com"];
        },
        resolve4: async () => ["66.249.66.1"],
        resolve6: async () => [],
        cancel: () => {},
      }),
    });
    expect(
      await Promise.all(
        Array.from({ length: 10 }, () => verify("66.249.66.1")),
      ),
    ).toEqual(Array.from({ length: 10 }, () => true));
    expect(queries).toBe(1);
    now = 60_000;
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

for (const phase of ["reverse", "forward"] as const) {
  test(`a ${phase} DNS deadline cancels its lookup and grants no exemption`, async () => {
    const entered = Promise.withResolvers<undefined>();
    const waiting = Promise.withResolvers<string[]>();
    let fireDeadline = () => {};
    let cancelled = 0;
    let forwardCalls = 0;
    let created = 0;
    const verify = createSearchCrawlerVerifier({
      scheduleTimeout: (expire, delayMs) => {
        expect(delayMs).toBe(2000);
        fireDeadline = expire;
        return () => {};
      },
      createDns: () => {
        created += 1;
        return {
          reverse: async () => {
            if (phase === "forward") {
              return ["crawl.googlebot.com"];
            }
            entered.resolve(undefined);
            return await waiting.promise;
          },
          resolve4: async () => {
            forwardCalls += 1;
            entered.resolve(undefined);
            return await waiting.promise;
          },
          resolve6: async () => [],
          cancel: () => {
            cancelled += 1;
            waiting.resolve(
              phase === "reverse" ? ["crawl.googlebot.com"] : ["66.249.66.1"],
            );
          },
        };
      },
    });
    const checking = verify("66.249.66.1");
    await entered.promise;
    fireDeadline();
    expect(await checking).toBe(false);
    expect(cancelled).toBe(1);
    expect(forwardCalls).toBe(phase === "reverse" ? 0 : 1);
    expect(await verify("66.249.66.1")).toBe(false);
    expect(created).toBe(1);
  });
}

test("DNS concurrency stays bounded and capacity refusals do not poison identities", async () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let created = 0;
  let reverseCalls = 0;
  const verify = createSearchCrawlerVerifier({
    createDns: () => {
      created += 1;
      let peer = "";
      return {
        reverse: async (address) => {
          peer = address;
          reverseCalls += 1;
          if (reverseCalls === 8) {
            entered.resolve(undefined);
          }
          await release.promise;
          return ["crawl.googlebot.com"];
        },
        resolve4: async () => [peer],
        resolve6: async () => [],
        cancel: () => {},
      };
    },
  });
  const active = Array.from({ length: 8 }, (_, i) =>
    verify(`192.0.2.${i + 1}`),
  );
  const duplicate = verify("192.0.2.1");
  await entered.promise;
  try {
    expect(await verify("192.0.2.9")).toBe(false);
    expect(created).toBe(8);
    expect(reverseCalls).toBe(8);
  } finally {
    release.resolve(undefined);
  }
  expect(await Promise.all(active)).toEqual(
    Array.from({ length: 8 }, () => true),
  );
  expect(await duplicate).toBe(true);
  expect(await verify("192.0.2.9")).toBe(true);
  expect(created).toBe(9);
  expect(reverseCalls).toBe(9);
  expect(await verify("192.0.2.9")).toBe(true);
  expect(created).toBe(9);
});

test("a bounded cache evicts old DNS answers and invalid addresses never start lookups", async () => {
  let calls = 0;
  const verify = createSearchCrawlerVerifier({
    createDns: () => ({
      reverse: async () => {
        calls += 1;
        return [];
      },
      resolve4: async () => [],
      resolve6: async () => [],
      cancel: () => {},
    }),
  });
  expect(await verify("not-an-address")).toBe(false);
  expect(calls).toBe(0);
  for (let i = 0; i < 513; i += 1) {
    expect(await verify(`192.0.${Math.floor(i / 256)}.${i % 256}`)).toBe(false);
  }
  expect(calls).toBe(513);
  expect(await verify("192.0.0.0")).toBe(false);
  expect(calls).toBe(514);
});

test("ordinary requests and missing socket peers cannot acquire crawler identity", async () => {
  let calls = 0;
  const verifyAddress = async () => {
    calls += 1;
    return true;
  };
  for (const { userAgent, server } of [
    {
      userAgent: "Browser",
      server: { requestIP: () => ({ address: "66.249.66.1" }) },
    },
    { userAgent: "Googlebot", server: null },
  ]) {
    expect(
      await isVerifiedSearchCrawler({
        request: new Request("http://localhost/v1/case/sitemap/shards", {
          headers: { "user-agent": userAgent },
        }),
        server,
        verifyAddress,
      }),
    ).toBe(false);
  }
  expect(calls).toBe(0);
});
