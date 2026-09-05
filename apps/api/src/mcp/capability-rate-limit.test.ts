import { describe, expect, test } from "bun:test";

import { createFeedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { toSafeId } from "@/api/lib/branded-types";
import {
  consumeInvokeCapabilityRateLimit,
  DEFAULT_INVOKE_RATE_LIMIT,
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
const user = (id: string) => toSafeId<"user">(id);

describe("resolveInvokeRateLimit", () => {
  test("defaults to the generous per-capability budget", () => {
    expect(resolveInvokeRateLimit("time-entries.create")).toEqual(
      DEFAULT_INVOKE_RATE_LIMIT,
    );
  });

  test("mirrors the stricter REST route limit for a translation run", () => {
    expect(resolveInvokeRateLimit("document-translations.runs.create")).toEqual(
      {
        windowMs: 60_000,
        max: 30,
      },
    );
    expect(
      resolveInvokeRateLimit("document-translations.runs.create"),
    ).not.toBe(DEFAULT_INVOKE_RATE_LIMIT);
  });

  test("mirrors the source-fetch REST limit for skill capabilities", () => {
    for (const capabilityId of [
      "skills.discover",
      "skills.import",
      "skills.import-url",
    ]) {
      expect(resolveInvokeRateLimit(capabilityId)).toEqual({
        windowMs: 60_000,
        max: 10,
      });
      expect(resolveInvokeRateLimit(capabilityId)).not.toBe(
        DEFAULT_INVOKE_RATE_LIMIT,
      );
    }
  });
});

describe("consumeInvokeCapabilityRateLimit", () => {
  test("allows up to the limit, then refuses", async () => {
    const guards = freshGuards();
    const max = resolveInvokeRateLimit("document-translations.runs.create").max;
    expect(max).toBeGreaterThan(0);
    const input = {
      capabilityId: "document-translations.runs.create",
      organizationId: org("org_a"),
      userId: user("user_a"),
      guards,
    };
    for (let i = 0; i < max; i += 1) {
      expect((await consumeInvokeCapabilityRateLimit(input)).ok).toBe(true);
    }
    const overflow = await consumeInvokeCapabilityRateLimit(input);
    expect(overflow.ok).toBe(false);
    expect(overflow.retryAfterSeconds).toBe(60);
  });

  test("distinct capabilities share no budget", async () => {
    const guards = freshGuards();
    const max = resolveInvokeRateLimit("document-translations.runs.create").max;
    const translate = {
      capabilityId: "document-translations.runs.create",
      organizationId: org("org_a"),
      userId: user("user_a"),
      guards,
    };
    for (let i = 0; i < max; i += 1) {
      await consumeInvokeCapabilityRateLimit(translate);
    }
    expect((await consumeInvokeCapabilityRateLimit(translate)).ok).toBe(false);
    // A different capability for the same org is unaffected.
    expect(
      (
        await consumeInvokeCapabilityRateLimit({
          capabilityId: "entities.upload",
          organizationId: org("org_a"),
          userId: user("user_a"),
          guards,
        })
      ).ok,
    ).toBe(true);
  });

  test("skill source capabilities share one per-IP budget across organizations", async () => {
    const max = resolveInvokeRateLimit("skills.discover").max;
    const counts = new Map<string, number>();
    const consumeSkillSource = async ({
      clientIp,
    }: {
      clientIp: string | null;
    }) => {
      const key = clientIp ?? "unknown";
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { ok: count <= max, retryAfterSeconds: 60 };
    };
    for (let i = 0; i < max - 1; i += 1) {
      await consumeInvokeCapabilityRateLimit({
        capabilityId: "skills.discover",
        clientIp: "192.0.2.1",
        consumeSkillSource,
        organizationId: org("org_a"),
        userId: user("user_a"),
      });
    }

    expect(
      (
        await consumeInvokeCapabilityRateLimit({
          capabilityId: "skills.import",
          clientIp: "192.0.2.1",
          consumeSkillSource,
          organizationId: org("org_b"),
          userId: user("user_a"),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await consumeInvokeCapabilityRateLimit({
          capabilityId: "skills.import-url",
          clientIp: "192.0.2.1",
          consumeSkillSource,
          organizationId: org("org_a"),
          userId: user("user_a"),
        })
      ).ok,
    ).toBe(false);
    expect(counts.get("192.0.2.1")).toBe(max + 1);
  });

  test("distinct callers in one organization share no budget", async () => {
    // The budget bounds what one caller can spend, so exhausting it must not
    // reach across to a colleague on the same capability.
    const guards = freshGuards();
    const max = resolveInvokeRateLimit("document-translations.runs.create").max;
    const first = {
      capabilityId: "document-translations.runs.create",
      organizationId: org("org_a"),
      userId: user("user_a"),
      guards,
    };
    for (let i = 0; i < max; i += 1) {
      await consumeInvokeCapabilityRateLimit(first);
    }
    expect((await consumeInvokeCapabilityRateLimit(first)).ok).toBe(false);
    expect(
      (
        await consumeInvokeCapabilityRateLimit({
          ...first,
          userId: user("user_b"),
        })
      ).ok,
    ).toBe(true);
  });

  test("distinct organizations share no budget", async () => {
    const guards = freshGuards();
    const max = resolveInvokeRateLimit("document-translations.runs.create").max;
    const orgA = {
      capabilityId: "document-translations.runs.create",
      organizationId: org("org_a"),
      userId: user("user_a"),
      guards,
    };
    for (let i = 0; i < max; i += 1) {
      await consumeInvokeCapabilityRateLimit(orgA);
    }
    expect((await consumeInvokeCapabilityRateLimit(orgA)).ok).toBe(false);
    expect(
      (
        await consumeInvokeCapabilityRateLimit({
          capabilityId: "document-translations.runs.create",
          organizationId: org("org_b"),
          userId: user("user_a"),
          guards,
        })
      ).ok,
    ).toBe(true);
  });
});
