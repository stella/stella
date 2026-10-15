import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import { toSafeId } from "@/api/lib/branded-types";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";

import { createLinkIconCache } from "./cache";

const enabled = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
const hostField = (hostname: string) => `h:${sha256Hex(hostname)}`;
const createFixture = async () => {
  const raw = createRedisClient({ storeClass: "cache" });
  await raw.connect();
  const slot = `link-icon-test:${Bun.randomUUIDv7()}`;
  const entries = coordinationKey({
    scope: "link-icons",
    slot,
    suffix: "entries",
  });
  const expiry = coordinationKey({
    scope: "link-icons",
    slot,
    suffix: "expiry",
  });
  const cache = createLinkIconCache({ slot, createRedis: () => raw });
  return {
    cache,
    raw,
    entries,
    expiry,
    dispose: async () => {
      await raw.send("DEL", [entries, expiry]);
      cache.close();
    },
  };
};

describe.skipIf(!enabled)("favicon cache over Valkey", () => {
  test("concurrent misses share one lease, then positive and negative results retain their own expiry", async () => {
    const fixture = await createFixture();
    const { cache, raw, entries, expiry } = fixture;
    const subject = {
      hostname: "positive.example",
      userId: toSafeId<"user">("user"),
      ip: "192.0.2.1",
    };
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => cache.readOrLease(subject)),
      );
      const leases = results.filter((result) => result.type === "lease");
      expect(leases).toHaveLength(1);
      expect(
        results.filter((result) => result.type === "no-icon"),
      ).toHaveLength(7);
      const lease = leases.at(0);
      if (lease?.type !== "lease") {
        throw new Error("Expected the sole origin lease");
      }
      const icon = {
        bytes: new Uint8Array([0, 127, 255]),
        mime: "image/png",
      } as const;
      expect(
        await cache.store({
          hostname: subject.hostname,
          token: lease.token,
          icon,
        }),
      ).toBe(true);
      expect(await cache.readOrLease(subject)).toEqual({ type: "hit", icon });
      const positiveExpiry = Number(
        await raw.send("ZSCORE", [expiry, hostField(subject.hostname)]),
      );
      expect(positiveExpiry - Math.floor(Date.now() / 1000)).toBeGreaterThan(
        604_790,
      );
      const negative = { ...subject, hostname: "negative.example" };
      const miss = await cache.readOrLease(negative);
      if (miss.type !== "lease") {
        throw new Error("Expected negative origin lease");
      }
      expect(
        await cache.store({
          hostname: negative.hostname,
          token: miss.token,
          icon: null,
        }),
      ).toBe(true);
      expect(await cache.readOrLease(negative)).toEqual({ type: "no-icon" });
      const negativeExpiry = Number(
        await raw.send("ZSCORE", [expiry, hostField(negative.hostname)]),
      );
      expect(negativeExpiry - Math.floor(Date.now() / 1000)).toBeGreaterThan(
        3590,
      );
      expect(
        negativeExpiry - Math.floor(Date.now() / 1000),
      ).toBeLessThanOrEqual(3600);
      // Even if eviction loses the expiry index, embedded expiry prevents stale hits.
      await raw.send("HSET", [entries, hostField(subject.hostname), "1:PAA=="]);
      await raw.send("DEL", [expiry]);
      expect((await cache.readOrLease(subject)).type).toBe("lease");
    } finally {
      await fixture.dispose();
    }
  });

  test("one user may miss on sixty distinct hosts, including retries of a previous host", async () => {
    const fixture = await createFixture();
    try {
      const subject = { userId: toSafeId<"user">("user"), ip: "192.0.2.1" };
      for (let index = 0; index < 60; index++) {
        expect(
          (
            await fixture.cache.readOrLease({
              ...subject,
              hostname: `host-${index}.example`,
            })
          ).type,
        ).toBe("lease");
      }
      expect(
        await fixture.cache.readOrLease({
          ...subject,
          hostname: "over-limit.example",
        }),
      ).toEqual({ type: "no-icon" });
      // Expire only the lease, retaining hourly distinct-host admission membership.
      await fixture.raw.send("HSET", [
        fixture.entries,
        hostField("host-0.example"),
        "1:Lexpired",
      ]);
      expect(
        (
          await fixture.cache.readOrLease({
            ...subject,
            hostname: "host-0.example",
          })
        ).type,
      ).toBe("lease");
    } finally {
      await fixture.dispose();
    }
  });

  test("encoded payloads and admission metadata stay within the global budget", async () => {
    const fixture = await createFixture();
    const icon = {
      bytes: new Uint8Array(65_536),
      mime: "image/x-icon",
    } as const;
    let refused = false;
    try {
      for (let index = 0; index < 400; index++) {
        const hostname = `budget-${index}.example`;
        const result = await fixture.cache.readOrLease({
          hostname,
          userId: toSafeId<"user">(`user-${index}`),
          ip: `ip-${index}`,
        });
        if (result.type !== "lease") {
          refused = true;
          break;
        }
        if (
          !(await fixture.cache.store({ hostname, token: result.token, icon }))
        ) {
          refused = true;
          break;
        }
      }
      expect(refused).toBe(true);
      const charged = Number(
        await fixture.raw.send("HGET", [fixture.entries, "__bytes"]),
      );
      expect(charged).toBeGreaterThan(31 * 1024 * 1024);
      expect(charged).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(
        Number(await fixture.raw.send("HLEN", [fixture.entries])),
      ).toBeLessThanOrEqual(16_384);
    } finally {
      await fixture.dispose();
    }
  }, 15_000);
});
