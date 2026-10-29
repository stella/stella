import { Result } from "better-result";
import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { Temporal } from "@stll/time";

import { resolveClientAddress } from "@/api/lib/client-ip";
import { logger } from "@/api/lib/observability/logger";
import type { RequestIpServer } from "@/api/lib/rate-limit/contracts";

const CRAWLER_DOMAINS = ["googlebot.com", "search.msn.com"] as const;
const MAX_CACHE_ENTRIES = 512;
const MAX_DNS_CHECKS = 8;
const POSITIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;

type CrawlerDns = {
  reverse: (address: string) => Promise<string[]>;
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
};

type CrawlerVerificationOptions = {
  dns?: CrawlerDns;
  now?: () => number;
};

/** A PTR name alone proves nothing: its provider must also resolve to the peer. */
export const createSearchCrawlerVerifier = ({
  dns = new Resolver({ timeout: 1000, tries: 1 }),
  now = () => Temporal.Now.instant().epochMilliseconds,
}: CrawlerVerificationOptions = {}) => {
  const cache = new Map<string, { expires: number; verified: boolean }>();
  const pending = new Map<string, Promise<boolean>>();

  return async (address: string): Promise<boolean> => {
    const family = isIP(address);
    if (family === 0) {
      return false;
    }
    const cached = cache.get(address);
    if (cached !== undefined && cached.expires > now()) {
      return cached.verified;
    }
    const checking = pending.get(address);
    if (checking !== undefined) {
      return await checking;
    }
    if (pending.size >= MAX_DNS_CHECKS) {
      return false;
    }
    const check = async () => {
      const result = await Result.tryPromise(async () => {
        const hosts = (await dns.reverse(address)).filter((host) =>
          CRAWLER_DOMAINS.some((domain) =>
            host.toLowerCase().replace(/\.$/u, "").endsWith(`.${domain}`),
          ),
        );
        // Bound even a malicious PTR response to one provider-owned name.
        const host = hosts.at(0);
        if (host === undefined) {
          return false;
        }
        const addresses = await (family === 4
          ? dns.resolve4(host)
          : dns.resolve6(host));
        const confirmed = new BlockList();
        for (const resolved of addresses) {
          confirmed.addAddress(resolved, family === 4 ? "ipv4" : "ipv6");
        }
        return confirmed.check(address, family === 4 ? "ipv4" : "ipv6");
      });
      if (result.isErr()) {
        logger.debug("api.crawler.dns_verification_failed", {});
      }
      const verified = result.isOk() && result.value;
      const first = cache.keys().next().value;
      if (cache.size >= MAX_CACHE_ENTRIES && first !== undefined) {
        cache.delete(first);
      }
      cache.set(address, {
        expires: now() + (verified ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
        verified,
      });
      return verified;
    };
    const promise = check();
    pending.set(address, promise);
    try {
      return await promise;
    } finally {
      pending.delete(address);
    }
  };
};

type SearchCrawlerRequestOptions = {
  request: Request;
  server: RequestIpServer | null;
  verifyAddress: ReturnType<typeof createSearchCrawlerVerifier>;
};

export const isVerifiedSearchCrawler = async ({
  request,
  server,
  verifyAddress,
}: SearchCrawlerRequestOptions): Promise<boolean> => {
  // The UA only avoids DNS work for ordinary requests; it cannot grant access.
  if (!/googlebot|bingbot/iu.test(request.headers.get("user-agent") ?? "")) {
    return false;
  }
  const client = resolveClientAddress(request, server);
  return client !== null && (await verifyAddress(client.address));
};
