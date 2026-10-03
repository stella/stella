import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { nonEvictingRedis } from "@/api/lib/non-evicting-redis";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { chargeMcpReadBytes } from "@/api/lib/rate-limit/mcp-read-fence";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";

const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";

describe.skipIf(!runValkeyTests)("admission policy over Valkey", () => {
  test("real INFO permits leases and refresh refuses both admission facades while raw reads work", async () => {
    const raw = createRedisClient({ storeClass: "cache" });
    await raw.connect();
    let override: string | undefined;
    let refresh = () => {};
    const commands = {
      send: async (command: string, args: string[]) => {
        const reply = await raw.send(command, args);
        if (
          command !== "INFO" ||
          override === undefined ||
          typeof reply !== "string"
        ) {
          return reply;
        }
        return reply.replace(
          /^maxmemory_policy:[^\r\n]+/mu,
          () => `maxmemory_policy:${String(override)}`,
        );
      },
    };
    const store = nonEvictingRedis({
      connection: {
        ready: async () => commands,
        close: () => raw.close(),
      },
      observe: () => {},
      scheduleRefresh: (callback) => {
        refresh = callback;
        return () => {};
      },
    });
    const organizationId = toSafeId<"organization">(
      `policy_${Bun.randomUUIDv7()}`,
    );
    const userId = toSafeId<"user">("policy_user");
    let executions = 0;
    const admit = async () =>
      await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        costRecorder: null,
        policy: {
          organizationConcurrency: 2,
          userConcurrency: 1,
          leaseMs: 120_000,
        },
        redisReady: store.ready,
        run: async () => {
          executions += 1;
          return "executed";
        },
      });
    try {
      const info = await raw.send("INFO", ["memory"]);
      expect(info).toEqual(
        expect.stringContaining("maxmemory_policy:noeviction"),
      );
      const admitted = await admit();
      expect(Result.isOk(admitted)).toBe(true);
      expect(executions).toBe(1);
      override = "allkeys-lru";
      refresh();
      const client = (await store.ready()).unwrap();
      const refused = await admit();
      expect(Result.isError(refused)).toBe(true);
      if (Result.isError(refused)) {
        expect(refused.error).toMatchObject({
          reason: "unavailable",
          message: expect.stringContaining("maxmemory-policy noeviction"),
        });
      }
      expect(executions).toBe(1);
      const fenced = await chargeMcpReadBytes({
        organizationId,
        userId,
        enabled: true,
        bytes: 1,
        readClass: "tenant",
        redis: client,
        policy: {
          windowMs: 60_000,
          maxEntries: 10,
          tenant: { organizationBytes: 100, userBytes: 100 },
          public: { organizationBytes: 100, userBytes: 100 },
        },
      });
      expect(Result.isError(fenced)).toBe(true);
      if (Result.isError(fenced)) {
        expect(fenced.error).toMatchObject({
          reason: "unavailable",
          message: expect.stringContaining("maxmemory-policy noeviction"),
        });
      }
      expect(
        await raw.send("GET", [
          coordinationKey({
            scope: "action-admission",
            slot: organizationId,
            suffix: "cache-probe",
          }),
        ]),
      ).toBeNull();
    } finally {
      store.close();
    }
  });
});
