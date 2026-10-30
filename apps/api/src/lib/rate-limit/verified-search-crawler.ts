import { Result } from "better-result";
import { BlockList, isIP } from "node:net";

import { createTtlFlightCache } from "@stll/concurrency/ttl-flight-cache";
import {
  withTimeout,
  type WithTimeoutScheduler,
} from "@stll/concurrency/with-timeout";
import { Temporal } from "@stll/time";

import { resolveClientAddress } from "@/api/lib/client-ip";
import { logger } from "@/api/lib/observability/logger";
import type { RequestIpServer } from "@/api/lib/rate-limit/contracts";
import { createBoundedDnsResolver } from "@/api/lib/safe-outbound-fetch";

const CRAWLER_DOMAINS = ["googlebot.com", "search.msn.com"] as const;
const MAX_CACHE_ENTRIES = 512;
const MAX_DNS_CHECKS = 8;
const CACHE_TTL_MS = 60_000;
const VERIFICATION_TIMEOUT_MS = 2000;
const MAX_DNS_RECORDS = 64;

type CrawlerDns = {
  reverse: (address: string) => Promise<string[]>;
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
  cancel: () => void;
};

type CrawlerVerificationOptions = {
  createDns?: () => CrawlerDns;
  now?: () => number;
  scheduleTimeout?: WithTimeoutScheduler;
};

/** A PTR name alone proves nothing: its provider must also resolve to the peer. */
export const createSearchCrawlerVerifier = ({
  createDns = createBoundedDnsResolver,
  now = () => Temporal.Now.instant().epochMilliseconds,
  scheduleTimeout,
}: CrawlerVerificationOptions = {}) => {
  const cache = createTtlFlightCache<boolean>({
    ttlMs: CACHE_TTL_MS,
    maxEntries: MAX_CACHE_ENTRIES,
    now,
  });
  let activeChecks = 0;

  return async (address: string): Promise<boolean> => {
    const family = isIP(address);
    if (family === 0) {
      return false;
    }
    return await cache.read(address, async () => {
      if (activeChecks >= MAX_DNS_CHECKS) {
        return false;
      }
      activeChecks += 1;
      try {
        const result = await Result.tryPromise(async () => {
          // Each verification owns its resolver, so cancelling one deadline
          // cannot cancel a different address's confirmation.
          const dns = createDns();
          return await withTimeout(
            async (signal) => {
              const cancel = () => dns.cancel();
              signal.addEventListener("abort", cancel, { once: true });
              try {
                const host = (await dns.reverse(address))
                  .slice(0, MAX_DNS_RECORDS)
                  .find((name) =>
                    CRAWLER_DOMAINS.some((domain) =>
                      name
                        .toLowerCase()
                        .replace(/\.$/u, "")
                        .endsWith(`.${domain}`),
                    ),
                  );
                signal.throwIfAborted();
                if (host === undefined) {
                  return false;
                }
                const addresses = await (family === 4
                  ? dns.resolve4(host)
                  : dns.resolve6(host));
                signal.throwIfAborted();
                const confirmed = new BlockList();
                for (const resolved of addresses.slice(0, MAX_DNS_RECORDS)) {
                  confirmed.addAddress(
                    resolved,
                    family === 4 ? "ipv4" : "ipv6",
                  );
                }
                return confirmed.check(address, family === 4 ? "ipv4" : "ipv6");
              } finally {
                signal.removeEventListener("abort", cancel);
              }
            },
            {
              label: "Search crawler DNS verification",
              timeoutMs: VERIFICATION_TIMEOUT_MS,
              scheduleTimeout,
            },
          );
        });
        if (result.isErr()) {
          logger.debug("api.crawler.dns_verification_failed", {});
        }
        return result.isOk() && result.value;
      } finally {
        activeChecks -= 1;
      }
    });
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
  // The UA avoids DNS work for ordinary requests; it cannot grant an exemption.
  if (!/googlebot|bingbot/iu.test(request.headers.get("user-agent") ?? "")) {
    return false;
  }
  const client = resolveClientAddress(request, server);
  return client !== null && (await verifyAddress(client.address));
};
