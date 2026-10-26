import { panic } from "better-result";

import { createLinkIconCache } from "@/api/handlers/chat/link-icons/cache";
import getExactIcon, {
  createGetExactIconHandler,
} from "@/api/handlers/chat/link-icons/get-exact";
import { toExactIconUrl } from "@/api/handlers/chat/link-icons/origin";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

export const exactIconScalingScenario = {
  name: "exact link icon cache hit",
  definition: getExactIcon,
  measure: async (size: number, createHandler = createGetExactIconHandler) => {
    const slot = `icon-scaling:${Bun.randomUUIDv7()}`;
    let redisRoundTrips = 0;
    const cache = createLinkIconCache({
      slot,
      createRedis: () => {
        const client = createRedisClient({ storeClass: "cache" });
        return {
          connect: async () => {
            await client.connect();
          },
          send: async (command, args) => {
            redisRoundTrips += 1;
            const response: unknown = await client.send(command, args);
            return response;
          },
          close: () => {
            client.close();
          },
        };
      },
    });
    const raw = createRedisClient({ storeClass: "cache" });
    const keys = ["entries", "expiry"].map((suffix) =>
      coordinationKey({ scope: "link-icons", slot, suffix }),
    );
    const urls = Array.from(
      { length: size },
      (_, index) => `https://example.com/${slot}/${index}.png`,
    );
    const first = urls.at(0) ?? panic("Cache scaling requires an icon");
    const bytes = Uint8Array.fromBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
    );
    try {
      await raw.connect();
      for (const [index, url] of urls.entries()) {
        const hostname =
          toExactIconUrl(url) ?? panic("Fixture public URL required");
        const lease = await cache.readOrLease({
          hostname,
          userId: mintAuthProviderId<"user">(),
          ip: `192.0.2.${index + 1}`,
        });
        if (
          lease.type !== "lease" ||
          !(await cache.store({
            hostname,
            token: lease.token,
            outcome: { type: "icon", icon: { bytes, mime: "image/png" } },
          }))
        ) {
          panic("Real cache fixture must acquire and fill every entry");
        }
      }
      const handler = createHandler(() => cache);
      const before = redisRoundTrips;
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await handler.handler(
          asTestRaw<Parameters<typeof handler.handler>[0]>({
            query: { url: first },
            route: "/v1/chat/link-icons/exact",
            user: { id: mintAuthProviderId<"user">() },
            memberRole: sessionMemberRole("owner"),
            request: new Request(
              "https://example.test/v1/chat/link-icons/exact",
            ),
            set: { headers: {} },
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          !(response instanceof Blob) ||
          response.type !== "image/png" ||
          response.size !== bytes.byteLength
        ) {
          panic(
            "Scaling must read the actual seeded icon, not a temporary/refused response",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: response.size,
          rows: 1,
          redisRoundTrips: redisRoundTrips - before,
        };
      });
    } finally {
      await raw.send("DEL", keys);
      cache.close();
      raw.close();
    }
  },
};
