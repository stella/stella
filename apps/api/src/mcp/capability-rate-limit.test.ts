import { describe, expect, test } from "bun:test";

import { createFeedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { toSafeId } from "@/api/lib/branded-types";
import {
  consumeInvokeCapabilityRateLimit,
  DEFAULT_INVOKE_RATE_LIMIT,
  INVOKE_RATE_LIMIT_OVERRIDES,
  resolveInvokeRateLimit,
} from "@/api/mcp/capability-rate-limit";

// A guards instance whose Redis always fails, so consumeCounter deterministically
// uses its in-memory fallback (no live Redis needed, no cross-test bleed).
const freshGuards = () =>
  createFeedbackIntakeGuards({
    createRedis: () => ({
      send: async () => {
        throw new Error("redis disabled in test");
      },
    }),
    onRedisError: () => undefined,
  });

const org = (id: string) => toSafeId<"organization">(id);

describe("resolveInvokeRateLimit", () => {
  test("defaults to the generous per-capability budget", () => {
    expect(resolveInvokeRateLimit("time-entries.create")).toEqual(
      DEFAULT_INVOKE_RATE_LIMIT,
    );
    expect(DEFAULT_INVOKE_RATE_LIMIT.max).toBe(60);
  });

  test("mirrors the stricter REST route limit for entities.translate", () => {
    expect(resolveInvokeRateLimit("entities.translate")).toEqual({
      windowMs: 60_000,
      max: 30,
    });
    expect(resolveInvokeRateLimit("entities.translate")).not.toBe(
      DEFAULT_INVOKE_RATE_LIMIT,
    );
  });
});

describe("consumeInvokeCapabilityRateLimit", () => {
  test("allows up to the limit, then refuses", async () => {
    const guards = freshGuards();
    const max = INVOKE_RATE_LIMIT_OVERRIDES["entities.translate"]?.max ?? 0;
    expect(max).toBeGreaterThan(0);
    const input = {
      capabilityId: "entities.translate",
      organizationId: org("org_a"),
      guards,
    };
    for (let i = 0; i < max; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential counter increments are the unit under test
      expect((await consumeInvokeCapabilityRateLimit(input)).ok).toBe(true);
    }
    const overflow = await consumeInvokeCapabilityRateLimit(input);
    expect(overflow.ok).toBe(false);
    expect(overflow.retryAfterSeconds).toBe(60);
  });

  test("distinct capabilities share no budget", async () => {
    const guards = freshGuards();
    const max = INVOKE_RATE_LIMIT_OVERRIDES["entities.translate"]?.max ?? 0;
    const translate = {
      capabilityId: "entities.translate",
      organizationId: org("org_a"),
      guards,
    };
    for (let i = 0; i < max; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential counter increments are the unit under test
      await consumeInvokeCapabilityRateLimit(translate);
    }
    expect((await consumeInvokeCapabilityRateLimit(translate)).ok).toBe(false);
    // A different capability for the same org is unaffected.
    expect(
      (
        await consumeInvokeCapabilityRateLimit({
          capabilityId: "entities.upload",
          organizationId: org("org_a"),
          guards,
        })
      ).ok,
    ).toBe(true);
  });

  test("distinct organizations share no budget", async () => {
    const guards = freshGuards();
    const max = INVOKE_RATE_LIMIT_OVERRIDES["entities.translate"]?.max ?? 0;
    const orgA = {
      capabilityId: "entities.translate",
      organizationId: org("org_a"),
      guards,
    };
    for (let i = 0; i < max; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential counter increments are the unit under test
      await consumeInvokeCapabilityRateLimit(orgA);
    }
    expect((await consumeInvokeCapabilityRateLimit(orgA)).ok).toBe(false);
    expect(
      (
        await consumeInvokeCapabilityRateLimit({
          capabilityId: "entities.translate",
          organizationId: org("org_b"),
          guards,
        })
      ).ok,
    ).toBe(true);
  });
});
