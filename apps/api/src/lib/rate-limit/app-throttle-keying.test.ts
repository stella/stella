import { describe, expect, test } from "bun:test";

import {
  createMcpAuthenticationFailureLimiter,
  MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
  mcpTransportAddressRateLimitKey,
} from "@/api/handlers/mcp/transport-rate-limit";
import { consumeSkillSourceRateLimit } from "@/api/handlers/skills/source-rate-limit";
import { toSafeId } from "@/api/lib/branded-types";
import { AUTH_TOKEN_ADDRESS_BUDGET } from "@/api/lib/rate-limit/auth-request-budget";
import {
  API_RATE_LIMITS,
  MCP_RATE_LIMITS,
} from "@/api/lib/rate-limit/budget-config";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import {
  createAccountAttemptBudget,
  OTP_ACCOUNT_BUDGET,
} from "@/api/lib/rate-limit/otp-account-budget";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import {
  DEFAULT_INVOKE_RATE_LIMIT,
  consumeInvokeCapabilityRateLimit,
} from "@/api/mcp/capability-rate-limit";
import { createMcpGatewayRateLimiter } from "@/api/mcp/gateway/rate-limit";

const transportRequest = (token: string) =>
  new Request("https://api.example/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

const createCounterContext = () => {
  const counts = new Map<string, number>();
  const counterKey = (requestKey: string) => requestKey.split("\u001f", 1)[0]!;
  return {
    increment: (requestKey: string, duration = 60_000) => {
      const key = counterKey(requestKey);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return {
        count,
        start: 1000,
        nextReset: new Date(1000 + duration),
      };
    },
    decrement: (requestKey: string) => {
      const key = counterKey(requestKey);
      counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
    },
    complete: () => undefined,
  } satisfies Pick<RateLimitContext, "increment" | "decrement" | "complete">;
};

describe("application throttle keying", () => {
  test("OAuth token admission shares only an equal address bucket", () => {
    expect(AUTH_TOKEN_ADDRESS_BUDGET.key("192.0.2.10")).toBe(
      AUTH_TOKEN_ADDRESS_BUDGET.key("192.0.2.10"),
    );
    expect(AUTH_TOKEN_ADDRESS_BUDGET.key("192.0.2.10")).not.toBe(
      AUTH_TOKEN_ADDRESS_BUDGET.key("192.0.2.11"),
    );
  });

  test("MCP authentication failures share an address bucket and reject after the configured limit", async () => {
    const context = new InMemoryRateLimitContext();
    const limiter = createMcpAuthenticationFailureLimiter(
      {
        ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
        context,
        generator: mcpTransportAddressRateLimitKey,
      },
      () => undefined,
    );
    const failure = new Response(null, { status: 401 });
    try {
      for (
        let attempt = 0;
        attempt < MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY.max;
        attempt += 1
      ) {
        const response = await limiter({
          request: transportRequest(`invalid-${attempt}`),
          clientIp: "192.0.2.10",
          run: async () => failure,
        });
        expect(response.status).toBe(401);
      }

      let ranRejectedRequest = false;
      const rejected = await limiter({
        request: transportRequest("another-invalid-token"),
        clientIp: "192.0.2.10",
        run: async () => {
          ranRejectedRequest = true;
          return failure;
        },
      });
      expect(rejected.status).toBe(429);
      expect(ranRejectedRequest).toBe(false);

      const isolatedAddress = await limiter({
        request: transportRequest("another-invalid-token"),
        clientIp: "192.0.2.11",
        run: async () => failure,
      });
      expect(isolatedAddress.status).toBe(401);
    } finally {
      context.kill();
    }
  });

  test("capability requests share only an equal organization, user, and capability bucket", async () => {
    const counts = new Map<string, number>();
    const guards = {
      consumeCounter: async ({ key, max }: { key: string; max: number }) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return count <= max;
      },
    };
    const consume = async (
      organizationId: string,
      userId: string,
      capabilityId = "time-entries.create",
    ) =>
      await consumeInvokeCapabilityRateLimit({
        capabilityId,
        organizationId: toSafeId<"organization">(organizationId),
        userId: toSafeId<"user">(userId),
        guards,
        recordRejection: () => undefined,
      });

    for (
      let attempt = 0;
      attempt < DEFAULT_INVOKE_RATE_LIMIT.max;
      attempt += 1
    ) {
      expect((await consume("org-a", "user-a")).ok).toBe(true);
    }
    expect((await consume("org-a", "user-a")).ok).toBe(false);
    expect((await consume("org-a", "user-b")).ok).toBe(true);
    expect((await consume("org-b", "user-a")).ok).toBe(true);
    expect((await consume("org-a", "user-a", "time-entries.list")).ok).toBe(
      true,
    );
  });

  test("skill-source requests isolate user and anonymous-address buckets at the configured limit", async () => {
    const context = createCounterContext();
    const consume = async (clientIp: string, userId?: string) =>
      await consumeSkillSourceRateLimit({
        clientIp,
        ...(userId ? { userId: toSafeId<"user">(userId) } : {}),
        context,
        recordRejection: () => undefined,
      });

    for (
      let attempt = 0;
      attempt < API_RATE_LIMITS.skillSource.max;
      attempt += 1
    ) {
      expect((await consume("192.0.2.10", "user-a")).ok).toBe(true);
    }
    expect((await consume("192.0.2.99", "user-a")).ok).toBe(false);
    expect((await consume("192.0.2.10", "user-b")).ok).toBe(true);

    for (
      let attempt = 0;
      attempt < API_RATE_LIMITS.skillSource.max;
      attempt += 1
    ) {
      expect((await consume("192.0.2.20")).ok).toBe(true);
    }
    expect((await consume("192.0.2.20")).ok).toBe(false);
    expect((await consume("192.0.2.21")).ok).toBe(true);
  });

  test("account attempts normalize equal identities and isolate different accounts at the configured limit", async () => {
    const owner = createAccountAttemptBudget(createCounterContext(), {
      counterPrefix: "otp-account",
      budgetFor: () => OTP_ACCOUNT_BUDGET,
    });

    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      expect((await owner.reserve(" Account@Example.Test ")).isOk()).toBe(true);
    }
    expect((await owner.reserve("account@example.test")).isErr()).toBe(true);
    expect((await owner.reserve("other@example.test")).isOk()).toBe(true);
  });

  test("gateway requests share only an equal user and connector bucket at the configured limit", async () => {
    const counts = new Map<string, number>();
    const limiter = createMcpGatewayRateLimiter({
      createRedis: () => ({
        send: async (_command, args) => {
          const key = args[2]!;
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return count;
        },
      }),
      recordRejection: () => undefined,
    });
    const consume = async (userId: string, connectorSlug: string) =>
      await limiter.consume({ userId, connectorSlug });

    for (let attempt = 0; attempt < MCP_RATE_LIMITS.gateway.max; attempt += 1) {
      expect(await consume("user-a", "registry-a")).toBe(true);
    }
    expect(await consume("user-a", "registry-a")).toBe(false);
    expect(await consume("user-b", "registry-a")).toBe(true);
    expect(await consume("user-a", "registry-b")).toBe(true);
  });
});
