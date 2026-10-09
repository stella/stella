import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";

import { createAnalysisFailureStore } from "./analysis-failure";

const enabled = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";

describe.skipIf(!enabled)("terminal analysis failures over Valkey", () => {
  test("polls retain failures and atomic retry clearing preserves newer failures", async () => {
    const client = createRedisClient({ storeClass: "cache" });
    const scope = {
      organizationId: toSafeId<"organization">(`failure_${Bun.randomUUIDv7()}`),
      decisionId: toSafeId<"caseLawDecision">("failure_decision"),
      fingerprint: "f".repeat(64),
    };
    const key = coordinationKey({
      scope: "case-law-analysis-failure",
      slot: `${scope.organizationId}:${scope.decisionId}`,
      suffix: scope.fingerprint,
    });
    const store = createAnalysisFailureStore({ createRedis: () => client });
    try {
      (await store.write(scope, undefined)).unwrap();
      const observed = (await store.read(scope)).unwrap();
      if (observed === null) {
        panic("Expected retained terminal failure");
      }
      expect((await store.read(scope)).unwrap()).toEqual(observed);
      const ttl = Number(await client.send("TTL", [key]));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
      const clears = await Promise.all([
        store.clear(scope, observed.failureId),
        store.clear(scope, observed.failureId),
      ]);
      expect(
        clears
          .map((result) => result.unwrap())
          .toSorted((left, right) => Number(left) - Number(right)),
      ).toEqual([false, true]);
      expect((await store.read(scope)).unwrap()).toBeNull();
      (await store.write(scope, undefined)).unwrap();
      const replacement = (await store.read(scope)).unwrap();
      expect(replacement?.failureId).not.toBe(observed.failureId);
      expect((await store.clear(scope, observed.failureId)).unwrap()).toBe(
        false,
      );
      expect((await store.read(scope)).unwrap()).toEqual(replacement);
    } finally {
      await client.send("DEL", [key]);
      client.close();
    }
  });
});
