import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import {
  createMcpAuthenticationFailureLimiter,
  MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
  mcpTransportAddressRateLimitKey,
  mcpTransportRateLimitKey,
  MCP_TRANSPORT_RATE_LIMIT_POLICY,
} from "@/api/handlers/mcp/transport-rate-limit";
import { createSkillSourceRateLimitGenerator } from "@/api/handlers/skills/source-rate-limit";
import { getAuth } from "@/api/lib/auth";
import { REVIEW_ACCOUNT_SIGN_IN_BUDGET } from "@/api/lib/auth/review-account-plugin";
import { toSafeId } from "@/api/lib/branded-types";
import { desktopRegistryKeyConfig } from "@/api/lib/business-registries/desktop/config";
import { MACHINE_API_KEY_RATE_LIMIT } from "@/api/lib/machine-api-key-config";
import { AUTH_FRAMEWORK_BUDGETS } from "@/api/lib/rate-limit/auth-framework-budget";
import {
  AUTH_ACCOUNT_REQUEST_BUDGET_RULES,
  AUTH_TOKEN_ADDRESS_BUDGET,
  AUTH_REQUEST_BUDGET_RULES,
  AUTH_REQUEST_IP_RULE_OVERRIDES,
  isAuthRequestBudgetPath,
} from "@/api/lib/rate-limit/auth-request-budget";
import {
  AUTH_RATE_LIMITS,
  API_RATE_LIMITS,
  ACCOUNT_ATTEMPT_RATE_LIMITS,
  MCP_RATE_LIMITS,
  API_KEY_RATE_LIMITS,
} from "@/api/lib/rate-limit/budget-config";
import {
  createAccountAttemptBudget,
  OTP_ACCOUNT_BUDGET,
} from "@/api/lib/rate-limit/otp-account-budget";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimitRequestKey } from "@/api/lib/rate-limit/redis-context";
import {
  DEFAULT_INVOKE_RATE_LIMIT,
  resolveInvokeRateLimit,
  consumeInvokeCapabilityRateLimit,
} from "@/api/mcp/capability-rate-limit";
import { createMcpGatewayRateLimiter } from "@/api/mcp/gateway/rate-limit";
import { MCP_RESOURCE_MODE_CONFIG } from "@/api/mcp/resource-policy-contract";

const readSource = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf-8");

const sharedPeer = { requestIP: () => ({ address: "192.0.2.10" }) };
const transportRequest = (token: string) =>
  new Request("https://api.example/mcp", {
    headers: { authorization: `Bearer ${token}` },
  });

type KeySubject = {
  userId: string;
  organizationId: string;
  capabilityId: string;
  connectorSlug: string;
};

const readCapabilityKey = async (subject: KeySubject) => {
  let key: string | undefined;
  await consumeInvokeCapabilityRateLimit({
    capabilityId: subject.capabilityId,
    clientIp: "192.0.2.10",
    organizationId: toSafeId<"organization">(subject.organizationId),
    userId: toSafeId<"user">(subject.userId),
    guards: {
      consumeCounter: async (input) => {
        key = input.key;
        return true;
      },
    },
  });
  return v.parse(v.string(), key);
};

const readGatewayKey = async (subject: KeySubject) => {
  let key: string | undefined;
  const limiter = createMcpGatewayRateLimiter({
    createRedis: () => ({
      send: async (_command, args) => {
        key = args.at(2);
        return 1;
      },
    }),
    now: () => 1000,
  });
  expect(await limiter.consume(subject)).toBe(true);
  return v.parse(v.string(), key);
};

const KEY_PROBES = {
  createMcpTransportRateLimitOptions: {
    readKey: async (subject: KeySubject) =>
      await mcpTransportRateLimitKey(
        transportRequest(subject.userId),
        sharedPeer,
      ),
    dimensions: ["userId"],
  },
  consumeInvokeCapabilityRateLimit: {
    readKey: readCapabilityKey,
    dimensions: ["userId", "organizationId", "capabilityId"],
  },
  skillSourceRateLimitBinding: {
    readKey: async (subject: KeySubject) =>
      await createSkillSourceRateLimitGenerator(async () =>
        toSafeId<"user">(subject.userId),
      )(transportRequest("source-credential"), sharedPeer),
    dimensions: ["userId"],
  },
  consumeMcpGatewayRateLimit: {
    readKey: readGatewayKey,
    dimensions: ["userId", "connectorSlug"],
  },
} as const satisfies Record<
  string,
  {
    readKey: (subject: KeySubject) => Promise<string>;
    dimensions: readonly (keyof KeySubject)[];
  }
>;

const ACCOUNT_KEY_PROBES = {
  "otp-account": OTP_ACCOUNT_BUDGET,
  "password-account": REVIEW_ACCOUNT_SIGN_IN_BUDGET,
} as const;

const baselineSubject = {
  userId: "user-a",
  organizationId: "org-a",
  capabilityId: "time-entries.create",
  connectorSlug: "registry",
};

const MCP_WIRING_FILES = [
  "server.ts",
  "handlers/mcp/routes.ts",
  "mcp/capability-tools.ts",
  "handlers/skills/routes.ts",
  "mcp/gateway/external-tools.ts",
] as const;

const limiterCensus = (sources: readonly string[]) => {
  const actual = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(
      /\b(createMcp\w*(?:RateLimitOptions|Limiter)|consume\w*RateLimit|skillSourceRateLimitBinding)\b/gu,
    )) {
      actual.add(v.parse(v.string(), match.at(1)));
    }
  }
  const expected = new Set([
    ...Object.keys(KEY_PROBES),
    "createMcpAuthenticationFailureLimiter",
  ]);
  return {
    missing: [...expected].filter((name) => !actual.has(name)).toSorted(),
    uncovered: [...actual].filter((name) => !expected.has(name)).toSorted(),
  };
};

describe("application throttle keying census", () => {
  test("every limiter in the census reads bounded configuration through the budget owner", () => {
    const configSource = readSource("lib/rate-limit/budget-config.ts");
    const schemaSource = readSource("env-schema.ts");
    expect(schemaSource).toContain("...rateLimitBudgetEnvSchema");
    expect(configSource).toContain("bindRateLimitBudgetReader");
    expect(readSource("env.ts")).toContain(
      "bindRateLimitBudgetReader(() => validatedEnv)",
    );
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
    const configuredOwners = {
      "handlers/mcp/transport-rate-limit.ts": [
        "API_RATE_LIMITS.mcpTransport.max",
        "API_RATE_LIMITS.mcpTransportAddress.max",
      ],
      "handlers/skills/source-rate-limit.ts": [
        "API_RATE_LIMITS.skillSource.max",
        "API_RATE_LIMITS.skillSource.duration",
      ],
      "mcp/capability-rate-limit.ts": [
        "MCP_RATE_LIMITS.capability",
        "API_RATE_LIMITS.skillSource.max",
      ],
      "mcp/gateway/rate-limit.ts": [
        "MCP_RATE_LIMITS.gateway.max",
        "MCP_RATE_LIMITS.gateway.windowMs",
      ],
      "lib/rate-limit/otp-account-budget.ts": [
        "ACCOUNT_ATTEMPT_RATE_LIMITS.otp",
        "ACCOUNT_ATTEMPT_RATE_LIMITS.demoOtp",
      ],
      "lib/auth/review-account-plugin.ts": [
        "ACCOUNT_ATTEMPT_RATE_LIMITS.password",
      ],
      "lib/rate-limit/auth-request-budget.ts": [
        "AUTH_RATE_LIMITS.oauthAnonymousAddress",
        "AUTH_RATE_LIMITS.authSharedAddress",
      ],
      "lib/rate-limit/auth-framework-budget.ts": [
        "AUTH_RATE_LIMITS.defaultEmail",
      ],
      "lib/rate-limit/standard-api.ts": ["API_RATE_LIMITS.api.max"],
      "lib/signup-abuse.ts": [
        "OTP_DELIVERY_RATE_LIMITS.existingAccountEmailMax",
      ],
      "lib/rate-limit/demo-action-budget.ts": ["DEMO_ACTION_RATE_LIMIT"],
      "lib/machine-api-key-config.ts": ["API_KEY_RATE_LIMITS.machine"],
      "lib/business-registries/desktop/config.ts": [
        "API_KEY_RATE_LIMITS.desktop",
      ],
    } as const;
    for (const [owner, readers] of Object.entries(configuredOwners)) {
      const source = readSource(owner);
      for (const reader of readers) {
        expect(source).toContain(reader);
      }
      expect(source).not.toMatch(
        /\b(?:max|window|windowMs|duration|durationMs):\s*\d/u,
      );
    }
    const authSource = readSource("lib/auth.ts");
    expect(authSource).toContain("...AUTH_FRAMEWORK_BUDGET_RULES");
    expect(authSource).toContain(
      "customStorage: observeFrameworkAuthStorage(authRateLimitStorage)",
    );
  });

  test("OAuth grant admission is address-keyed, broad, and charged before identity lookup", () => {
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
    const source = readSource("lib/rate-limit/auth-request-budget.ts");
    const admission = source.indexOf("await storage.reserve(");
    const resolution = source.indexOf(
      "const identity = await resolveAuthRequestBudgetIdentity",
    );
    expect(admission).toBeGreaterThan(0);
    expect(resolution).toBeGreaterThan(admission);
  });

  test("every direct API middleware policy labels its configured budget", () => {
    const sources = [
      "server.ts",
      "handlers/me/routes.ts",
      "handlers/hosted-usage-webhook/routes.ts",
      "handlers/document-translations/routes.ts",
      "handlers/uploads/routes.ts",
      "handlers/entities/routes.ts",
      "handlers/style-sets/routes.ts",
      "lib/rate-limit/standard-api.ts",
      "lib/rate-limit/public-corpus-rate-limit-composition.ts",
      "lib/rate-limit/public-corpus-rate-limits.ts",
    ];
    let policies = 0;
    for (const source of sources.map(readSource)) {
      for (const match of source.matchAll(
        /max: API_RATE_LIMITS\.(\w+)\.max,([\s\S]*?)\.\.\.createRedis(?:RateLimit|Binding)\(/gu,
      )) {
        policies += 1;
        const metadata = v.parse(v.string(), match.at(2));
        expect(metadata).toMatch(
          /budget:\s*\{\s*name: "api\.[a-z_.]+",\s*keyKind: "address",?\s*\}/u,
        );
      }
    }
    expect(policies).toBe(14);
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
    expect(readSource("lib/rate-limit/auth-request-budget.ts")).toMatch(
      /Object\.hasOwn\(\s*AUTH_ACCOUNT_REQUEST_BUDGET_RULES,\s*path\s*\)/u,
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
    const policy = readSource("lib/auth/oauth-registration-policy.ts");
    expect(policy).toMatch(
      /before:\s*\[\s*\{\s*matcher:[\s\S]*?isAuthRequestBudgetPath\(ctx\.path \?\? ""\) &&\s*\(ctx\.path\?\.startsWith\("\/oauth2\/"\) \?\? false\),\s*handler: createAuthMiddleware\(/u,
    );
    expect(policy).toMatch(
      /createAuthRequestBudgetHook\(\{\s*\.\.\.requestBudget,\s*type: "oauth",\s*providerOptions: policyOptions,/u,
    );
    expect(policy).toMatch(
      /matcher: \(ctx: HookEndpointContext\) => ctx.path === "\/oauth2\/token",\s*handler: createAuthMiddleware\(enforceRequestBudget.complete\)/u,
    );
    expect(readSource("lib/auth/request-budget-hooks.ts")).toContain(
      "complete: checkBudget.complete",
    );
    expect(readSource("lib/auth/request-budget-hooks.ts")).toMatch(
      /const budget = await checkBudget\(ctx\);\s*if \(budget\.isErr\(\)\) \{\s*throw budget\.error;/u,
    );
    const authSource = readSource("lib/auth.ts");
    expect(authSource).toMatch(
      /requestBudget:\s*\{\s*storage: authRateLimitStorage,\s*enabled: rateLimitEnabled,/u,
    );
    expect(authSource).toMatch(
      /const signInRequestBudget = createAuthRequestBudgetHook\(\{\s*type: "authentication",\s*storage: authRateLimitStorage,\s*enabled: rateLimitEnabled,/u,
    );
    expect(authSource).toMatch(
      /before: createAuthMiddleware\(async \(ctx\) => \{\s*await signInRequestBudget\(ctx\);/u,
    );
  });

  test("the composed MCP limiter census equals the exercised key owners and authentication failure owner", () => {
    expect(limiterCensus(MCP_WIRING_FILES.map(readSource))).toEqual({
      missing: [],
      uncovered: [],
    });
    const server = readSource("server.ts");
    expect(server).toMatch(
      /\.use\(rateLimit\(createMcpTransportRateLimitOptions\(\)\)\)\s*\.use\(mcpRoute\)/u,
    );
    expect(readSource("handlers/mcp/routes.ts")).toMatch(
      /limitAuthenticationFailure:\s*createMcpAuthenticationFailureLimiter\(\)/u,
    );
    const transport = readSource("handlers/mcp/routes-core.ts");
    expect(transport).toMatch(
      /run: (?:async )?\(\) => (?:await )?handleMcpHttpRequest\(request, options\)/u,
    );
    const limiterSource = readSource("handlers/mcp/transport-rate-limit.ts");
    const reservation = limiterSource.indexOf(
      "await options.context.increment(",
    );
    const verification = limiterSource.indexOf("const response = await run()");
    expect(reservation).toBeGreaterThan(0);
    expect(verification).toBeGreaterThan(reservation);
    expect(limiterSource).toContain("await options.context.decrement(key,");
    expect(readSource("mcp/capability-tools.ts")).toMatch(
      /organizationId: context\.organizationId,\s*userId: context\.userId,/u,
    );
    expect(readSource("handlers/skills/source-rate-limit.ts")).toMatch(
      /resolveRateLimitSessionUserId\(request.headers\)/u,
    );
    expect(readSource("lib/auth.ts")).toMatch(
      /disableCookieCache: true, disableRefresh: true/u,
    );
    expect(readSource("handlers/skills/routes.ts")).toMatch(
      /\.\.\.skillSourceRateLimitBinding,/u,
    );
    expect(readSource("mcp/gateway/external-tools.ts")).toMatch(
      /consumeMcpGatewayRateLimit\(\{\s*connectorSlug: resolved\.connectorSlug,\s*userId: context\.userId,/u,
    );
  });

  test("the limiter census detects added and removed owners", () => {
    const expected = [
      ...Object.keys(KEY_PROBES),
      "createMcpAuthenticationFailureLimiter",
    ];
    const fixture = expected.map((name) => `${name}();`).join("\n");
    expect(limiterCensus([fixture])).toEqual({ missing: [], uncovered: [] });
    expect(
      limiterCensus([fixture, "createMcpAdditionalRateLimitOptions();"]),
    ).toEqual({
      missing: [],
      uncovered: ["createMcpAdditionalRateLimitOptions"],
    });
    for (const removed of expected) {
      const reduced = expected
        .filter((name) => name !== removed)
        .map((name) => `${name}();`)
        .join("\n");
      expect(limiterCensus([reduced])).toEqual({
        missing: [removed],
        uncovered: [],
      });
    }
  });

  test("account budget wiring covers the sign-in attempt counters", () => {
    const source = readSource("lib/auth.ts");
    const factories = new Set(
      [
        ...source.matchAll(
          /\b(createOtpAccountLimitPlugin|createAccountAttemptBudget)\b/gu,
        ),
      ].map((match) => v.parse(v.string(), match.at(1))),
    );
    expect([...factories].toSorted()).toEqual([
      "createAccountAttemptBudget",
      "createOtpAccountLimitPlugin",
    ]);
    expect(source).toMatch(
      /createOtpAccountLimitPlugin\(\{\s*enabled: rateLimitEnabled,\s*context: new RedisRateLimitContext\(/u,
    );
    expect(source).toMatch(
      /signInBudget: !rateLimitEnabled\s*\? undefined\s*: createAccountAttemptBudget\(/u,
    );
    expect(source).toMatch(
      /counterPrefix: "password-account",\s*nameFor: \(\) => "auth.password.account",\s*budgetFor: \(\) => REVIEW_ACCOUNT_SIGN_IN_BUDGET,/u,
    );
    expect(readSource("lib/rate-limit/otp-account-budget.ts")).toMatch(
      /createAccountAttemptBudget\(context, \{\s*counterPrefix: "otp-account",/u,
    );
    expect(OTP_ACCOUNT_BUDGET).toEqual({ max: 10, durationMs: 15 * 60 * 1000 });
    expect(REVIEW_ACCOUNT_SIGN_IN_BUDGET).toEqual({
      max: 10,
      durationMs: 60 * 60 * 1000,
    });
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

  test.each(Object.entries(KEY_PROBES))(
    "%s separates each authenticated subject dimension behind one address",
    async (_name, probe) => {
      const original = await probe.readKey(baselineSubject);
      expect(await probe.readKey(baselineSubject)).toBe(original);
      for (const dimension of probe.dimensions) {
        const changed = {
          ...baselineSubject,
          [dimension]: `${baselineSubject[dimension]}-other`,
        };
        expect(await probe.readKey(changed)).not.toBe(original);
      }
    },
  );

  test("the shared address limiter consumes only MCP authentication failures", async () => {
    const context = new InMemoryRateLimitContext();
    const limiter = createMcpAuthenticationFailureLimiter({
      ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
      context,
      generator: mcpTransportAddressRateLimitKey,
      max: 1,
    });
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
