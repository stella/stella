import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import {
  createMcpAuthenticationFailureLimiter,
  MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
  MCP_TRANSPORT_RATE_LIMIT_POLICY,
  mcpTransportAddressRateLimitKey,
  mcpTransportRateLimitKey,
} from "@/api/handlers/mcp/transport-rate-limit";
import { consumeSkillSourceRateLimit } from "@/api/handlers/skills/source-rate-limit";
import { getAuth } from "@/api/lib/auth";
import { REVIEW_ACCOUNT_SIGN_IN_BUDGET } from "@/api/lib/auth/review-account-plugin";
import { toSafeId } from "@/api/lib/branded-types";
import { desktopRegistryKeyConfig } from "@/api/lib/business-registries/desktop/config";
import { MACHINE_API_KEY_RATE_LIMIT } from "@/api/lib/machine-api-key-config";
import { AUTH_FRAMEWORK_BUDGETS } from "@/api/lib/rate-limit/auth-framework-budget";
import {
  AUTH_ACCOUNT_REQUEST_BUDGET_RULES,
  AUTH_REQUEST_BUDGET_RULES,
  AUTH_REQUEST_IP_RULE_OVERRIDES,
  AUTH_TOKEN_ADDRESS_BUDGET,
  isAuthRequestBudgetPath,
} from "@/api/lib/rate-limit/auth-request-budget";
import {
  ACCOUNT_ATTEMPT_RATE_LIMITS,
  API_KEY_RATE_LIMITS,
  API_RATE_LIMITS,
  AUTH_RATE_LIMITS,
  MCP_RATE_LIMITS,
} from "@/api/lib/rate-limit/budget-config";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import {
  createAccountAttemptBudget,
  OTP_ACCOUNT_BUDGET,
} from "@/api/lib/rate-limit/otp-account-budget";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimitRequestKey } from "@/api/lib/rate-limit/redis-context";
import {
  consumeInvokeCapabilityRateLimit,
  DEFAULT_INVOKE_RATE_LIMIT,
  resolveInvokeRateLimit,
} from "@/api/mcp/capability-rate-limit";
import { createMcpGatewayRateLimiter } from "@/api/mcp/gateway/rate-limit";
import { MCP_RESOURCE_MODE_CONFIG } from "@/api/mcp/resource-policy-contract";

const ACCOUNT_KEY_PROBES = {
  "otp-account": OTP_ACCOUNT_BUDGET,
  "password-account": REVIEW_ACCOUNT_SIGN_IN_BUDGET,
} as const;

const sharedPeer = { requestIP: () => ({ address: "192.0.2.10" }) };
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
  test("limiter policies use the canonical configured budgets", () => {
    const authRules = new Set(Object.values(AUTH_RATE_LIMITS));
    for (const rule of Object.values(AUTH_REQUEST_BUDGET_RULES)) {
      expect(authRules.has(rule)).toBe(true);
    }
    for (const { rule } of Object.values(AUTH_FRAMEWORK_BUDGETS)) {
      expect(authRules.has(rule)).toBe(true);
    }
    expect(MCP_TRANSPORT_RATE_LIMIT_POLICY.max).toBe(
      API_RATE_LIMITS.mcpTransport.max,
    );
    expect(MCP_TRANSPORT_RATE_LIMIT_POLICY.duration).toBe(
      API_RATE_LIMITS.mcpTransport.duration,
    );
    expect(MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY.max).toBe(
      API_RATE_LIMITS.mcpTransportAddress.max,
    );
    expect(MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY.duration).toBe(
      API_RATE_LIMITS.mcpTransportAddress.duration,
    );
    expect(DEFAULT_INVOKE_RATE_LIMIT).toBe(MCP_RATE_LIMITS.capability);
    expect(resolveInvokeRateLimit("skills.discover")).toEqual({
      max: API_RATE_LIMITS.skillSource.max,
      windowMs: API_RATE_LIMITS.skillSource.duration,
    });
    expect(resolveInvokeRateLimit("entities.upload")).toEqual({
      max: API_RATE_LIMITS.upload.max,
      windowMs: API_RATE_LIMITS.upload.duration,
    });
    expect(resolveInvokeRateLimit("document-translations.runs.create")).toEqual(
      {
        max: API_RATE_LIMITS.translate.max,
        windowMs: API_RATE_LIMITS.translate.duration,
      },
    );
    expect(OTP_ACCOUNT_BUDGET).toBe(ACCOUNT_ATTEMPT_RATE_LIMITS.otp);
    expect(REVIEW_ACCOUNT_SIGN_IN_BUDGET).toBe(
      ACCOUNT_ATTEMPT_RATE_LIMITS.password,
    );
    expect(MACHINE_API_KEY_RATE_LIMIT).toBe(API_KEY_RATE_LIMITS.machine);
    expect(desktopRegistryKeyConfig.rateLimit).toBe(
      API_KEY_RATE_LIMITS.desktop,
    );
    expect(OTP_ACCOUNT_BUDGET).toEqual({ max: 10, durationMs: 15 * 60 * 1000 });
    expect(REVIEW_ACCOUNT_SIGN_IN_BUDGET).toEqual({
      max: 10,
      durationMs: 60 * 60 * 1000,
    });
  });

  test("every owned auth path replaces the framework IP rule and matches the provider hook", () => {
    const auth = getAuth();
    const rules = auth.options.rateLimit.customRules;
    expect(Object.keys(AUTH_REQUEST_IP_RULE_OVERRIDES).toSorted()).toEqual(
      Object.keys(AUTH_REQUEST_BUDGET_RULES).toSorted(),
    );
    expect(rules).toMatchObject(AUTH_REQUEST_IP_RULE_OVERRIDES);
    for (const [path, rule] of Object.entries(AUTH_REQUEST_BUDGET_RULES)) {
      expect(AUTH_REQUEST_IP_RULE_OVERRIDES[path]).toBe(false);
      expect(isAuthRequestBudgetPath(path)).toBe(true);
      expect(rule.window).toBeGreaterThan(0);
      expect(rule.max).toBeGreaterThan(0);
    }
    for (const path of [
      "/oauth2/authorize",
      "/oauth2/token",
      "/oauth2/register",
      "/sign-in/email",
      "/sign-in/email-otp",
      "/sign-in/social",
      "/email-otp/send-verification-otp",
    ]) {
      expect(isAuthRequestBudgetPath(path)).toBe(true);
    }
    const shippedPaths = new Set(
      Object.values(auth.api).flatMap((endpoint) =>
        "path" in endpoint && typeof endpoint.path === "string"
          ? [endpoint.path]
          : [],
      ),
    );
    expect(
      [...shippedPaths]
        .filter((path) => path.startsWith("/sign-in/"))
        .toSorted(),
    ).toEqual(
      Object.keys(AUTH_REQUEST_BUDGET_RULES)
        .filter((path) => path.startsWith("/sign-in/"))
        .toSorted(),
    );
    for (const path of Object.keys(AUTH_REQUEST_BUDGET_RULES)) {
      expect(shippedPaths.has(path)).toBe(true);
    }
    expect(AUTH_REQUEST_BUDGET_RULES).toMatchObject(
      AUTH_ACCOUNT_REQUEST_BUDGET_RULES,
    );
    const provider = v.parse(
      v.looseObject({
        options: v.looseObject({
          rateLimit: v.record(v.string(), v.unknown()),
        }),
      }),
      auth.options.plugins.find(({ id }) => id === "oauth-provider"),
    );
    const oauthRules = Object.entries(AUTH_REQUEST_BUDGET_RULES).filter(
      ([path]) => path.startsWith("/oauth2/"),
    );
    expect(oauthRules).toHaveLength(3);
    for (const [path, rule] of oauthRules) {
      expect(provider.options.rateLimit[path.slice("/oauth2/".length)]).toEqual(
        rule,
      );
    }
  });

  test("OAuth grant admission uses the shared address budget and private key", () => {
    expect(AUTH_TOKEN_ADDRESS_BUDGET.rule).toBe(
      AUTH_RATE_LIMITS.authSharedAddress,
    );
    expect(AUTH_TOKEN_ADDRESS_BUDGET.name).toBe("auth.token.address");
    expect(AUTH_TOKEN_ADDRESS_BUDGET.keyKind).toBe("address");
    expect(AUTH_TOKEN_ADDRESS_BUDGET.rule.max).toBeGreaterThan(
      AUTH_RATE_LIMITS.oauthToken.max,
    );
    const key = AUTH_TOKEN_ADDRESS_BUDGET.key("198.51.100.10");
    expect(key).toBe(`/oauth2/token:address:${sha256Hex("198.51.100.10")}`);
    expect(key).not.toBe(AUTH_TOKEN_ADDRESS_BUDGET.key("203.0.113.10"));
  });

  test("OAuth token admission shares only an equal address bucket", () => {
    expect(AUTH_TOKEN_ADDRESS_BUDGET.key("192.0.2.10")).toBe(
      `/oauth2/token:address:${sha256Hex("192.0.2.10")}`,
    );
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
  test("transport credentials keep distinct token buckets at a shared address", async () => {
    const original = await mcpTransportRateLimitKey(
      transportRequest("token-a"),
      sharedPeer,
    );
    expect(
      await mcpTransportRateLimitKey(transportRequest("token-a"), sharedPeer),
    ).toBe(original);
    expect(
      await mcpTransportRateLimitKey(transportRequest("token-b"), sharedPeer),
    ).not.toBe(original);
  });

  test.each(Object.entries(ACCOUNT_KEY_PROBES))(
    "%s hashes normalized accounts and separates refund attempts",
    async (counterPrefix, rule) => {
      const durations: (number | undefined)[] = [];
      const capturedKeys: string[] = [];
      const owner = createAccountAttemptBudget(
        {
          increment: async (key, duration) => {
            capturedKeys.push(key);
            durations.push(duration);
            return {
              count: 1,
              start: 1000,
              nextReset: new Date(1000 + rule.durationMs),
            };
          },
          decrement: async () => undefined,
          complete: async () => undefined,
        },
        { counterPrefix, budgetFor: () => rule },
      );
      const first = (await owner.reserve(" Account@Example.Test ")).unwrap();
      const sameAccount = (
        await owner.reserve("account@example.test")
      ).unwrap();
      const otherAccount = (await owner.reserve("other@example.test")).unwrap();
      expect(capturedKeys).toEqual([first, sameAccount, otherAccount]);
      const canonicalPrefix = createRedisRateLimitRequestKey({
        counterKey: `${counterPrefix}:${sha256Hex("account@example.test")}`,
        requestId: "",
      });
      for (const key of [first, sameAccount]) {
        expect(key.startsWith(canonicalPrefix)).toBe(true);
        expect(
          v.safeParse(
            v.pipe(v.string(), v.uuid()),
            key.slice(canonicalPrefix.length),
          ).success,
        ).toBe(true);
        expect(key).not.toContain("account@example.test");
      }
      expect(first).not.toBe(sameAccount);
      expect(otherAccount.startsWith(canonicalPrefix)).toBe(false);
      const otherPrefix = createRedisRateLimitRequestKey({
        counterKey: `${counterPrefix}:${sha256Hex("other@example.test")}`,
        requestId: "",
      });
      expect(otherAccount.startsWith(otherPrefix)).toBe(true);
      for (const prefix of Object.keys(ACCOUNT_KEY_PROBES)) {
        if (prefix === counterPrefix) {
          continue;
        }
        const unrelatedPrefix = createRedisRateLimitRequestKey({
          counterKey: `${prefix}:${sha256Hex("account@example.test")}`,
          requestId: "",
        });
        expect(first.startsWith(unrelatedPrefix)).toBe(false);
      }
      expect(durations).toEqual([
        rule.durationMs,
        rule.durationMs,
        rule.durationMs,
      ]);
    },
  );

  test("the shared address limiter consumes only MCP authentication failures", async () => {
    const context = new InMemoryRateLimitContext();
    const limiter = createMcpAuthenticationFailureLimiter(
      {
        ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
        context,
        generator: mcpTransportAddressRateLimitKey,
        max: 1,
      },
      () => undefined,
    );
    try {
      for (const resource of Object.values(MCP_RESOURCE_MODE_CONFIG)) {
        const request = new Request(`https://api.example${resource.httpPath}`, {
          method: "POST",
        });
        for (const status of [200, 204, 400, 403, 500]) {
          const response = new Response(null, { status });
          expect(
            await limiter({
              request,
              run: async () => response,
              clientIp: "192.0.2.10",
            }),
          ).toBe(response);
        }
      }
      const request = transportRequest("invalid-credential");
      expect(await mcpTransportAddressRateLimitKey(request, sharedPeer)).toBe(
        await mcpTransportAddressRateLimitKey(
          transportRequest("another-invalid-credential"),
          sharedPeer,
        ),
      );
      expect(
        await mcpTransportAddressRateLimitKey(request, {
          requestIP: () => ({ address: "192.0.2.11" }),
        }),
      ).not.toBe(await mcpTransportAddressRateLimitKey(request, sharedPeer));
      const failure = new Response(null, { status: 401 });
      expect(
        await limiter({
          request,
          run: async () => failure,
          clientIp: "192.0.2.10",
        }),
      ).toBe(failure);
      let verified = false;
      expect(
        (
          await limiter({
            request: transportRequest("invalid-credential"),
            clientIp: "192.0.2.10",
            run: async () => {
              verified = true;
              return failure;
            },
          })
        ).status,
      ).toBe(429);
      expect(verified).toBe(false);
      expect(
        await limiter({
          request,
          run: async () => failure,
          clientIp: "192.0.2.11",
        }),
      ).toBe(failure);
    } finally {
      context.kill();
    }
  });
});
