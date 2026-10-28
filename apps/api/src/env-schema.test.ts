import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import { envBaseServerSchema } from "@/api/env-base-schema";
import {
  documentProcessingEnvInvariantViolation,
  scheduledJobsModeSchema,
} from "@/api/env-document-processing-worker-schema";

import {
  envApiInvariantViolation,
  envApiServerSchema,
  freeTierInvariantViolation,
} from "./env-schema";

test("generated views require explicit deployment enablement", () => {
  expect(v.parse(envApiServerSchema.FEATURE_GENERATED_VIEWS, undefined)).toBe(
    false,
  );
  expect(v.parse(envApiServerSchema.FEATURE_GENERATED_VIEWS, "false")).toBe(
    false,
  );
  expect(v.parse(envApiServerSchema.FEATURE_GENERATED_VIEWS, "true")).toBe(
    true,
  );
});

test("agent client storage format requires explicit enablement", () => {
  const schema = envApiServerSchema.AGENT_CLIENT_STORAGE_V1_ENABLED;
  expect(v.parse(schema, undefined)).toBe(false);
  expect(v.parse(schema, "false")).toBe(false);
  expect(v.parse(schema, "true")).toBe(true);
});

test("feature access grants default to empty and discard unknown production feature ids", () => {
  const schema = envBaseServerSchema.API_FEATURE_ACCESS_GRANTS;
  expect(v.parse(schema, undefined)).toEqual({
    grants: {},
    unknownGrantCount: 0,
  });
  expect(v.parse(schema, "{}")).toEqual({ grants: {}, unknownGrantCount: 0 });
  expect(
    v.parse(
      schema,
      '{"unknown-feature":[{"type":"member","organizationId":"org-a","email":"member@example.test"}]}',
    ),
  ).toEqual({ grants: {}, unknownGrantCount: 1 });
});

for (const name of [
  "ACTION_COST_RETENTION_DAYS",
  "HOSTED_USAGE_WEBHOOK_RETENTION_DAYS",
] as const) {
  test(`${name} keeps cutoff timestamps in positive ISO years`, () => {
    const schema = envApiServerSchema[name];
    expect(v.parse(schema, undefined)).toBeUndefined();
    const now = new Date("2021-03-04T10:00:00Z");
    for (const days of [1, 17, 365_000]) {
      const parsed = v.safeParse(schema, String(days));
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.output !== undefined) {
        const cutoff = new Date(now.getTime() - parsed.output * DAY_IN_MS);
        expect(cutoff.getUTCFullYear()).toBeGreaterThan(0);
        expect(cutoff.toISOString()).toMatch(/^\d{4}-/u);
      }
    }
    for (const invalid of ["0", "-1", "1.2", "100000000"]) {
      expect(v.safeParse(schema, invalid).success).toBe(false);
    }
  });
}

const environment = {
  BETTER_AUTH_URL: "https://example.test",
  FRONTEND_URL: "https://example.test",
  GOTENBERG_URL: "https://example.test",
  E2E_DISABLE_AUTH_RATE_LIMIT: false,
  USE_MOCK_AI: false,
  nodeEnv: "production",
  runtimeMode: { mode: "strict" },
} as const satisfies Parameters<typeof envApiInvariantViolation>[0];

test("scheduled jobs default to enabled and can be disabled only in local development and tests", () => {
  expect(v.parse(scheduledJobsModeSchema, undefined)).toBe("enabled");
  expect(v.parse(scheduledJobsModeSchema, "disabled")).toBe("disabled");
  expect(v.safeParse(scheduledJobsModeSchema, "false").success).toBe(false);
  const workerEnvironment = {
    contentEncryptionKey: "a".repeat(64),
    redisUrl: "redis://localhost:6379",
    scheduledJobsMode: "disabled",
  } as const;
  expect(
    documentProcessingEnvInvariantViolation({
      ...workerEnvironment,
      runtimeMode: { mode: "strict" },
    }),
  ).toContain("only supported in local development and tests");
  expect(
    documentProcessingEnvInvariantViolation({
      ...workerEnvironment,
      runtimeMode: { mode: "open" },
    }),
  ).toBeNull();
});

test("the restricted review account is configured with both keys or neither", () => {
  for (const email of [undefined, "review@example.test"]) {
    for (const organizationId of [undefined, "org_review"]) {
      expect(
        envApiInvariantViolation({
          ...environment,
          APP_REVIEW_ACCOUNT_EMAIL: email,
          APP_REVIEW_ORGANIZATION_ID: organizationId,
        }),
      ).toBe(
        (email === undefined) === (organizationId === undefined)
          ? null
          : "APP_REVIEW_ACCOUNT_EMAIL and APP_REVIEW_ORGANIZATION_ID must be set together.",
      );
    }
  }
});

test("Sign in with Apple boots only fully configured, with a readable key", () => {
  const apple = {
    APPLE_AUTH_CLIENT_ID: "app.example.web",
    APPLE_AUTH_TEAM_ID: "TEAM123456",
    APPLE_AUTH_KEY_ID: "KEY1234567",
    APPLE_AUTH_PRIVATE_KEY: generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
  expect(envApiInvariantViolation({ ...environment, ...apple })).toBeNull();
  expect(
    envApiInvariantViolation({
      ...environment,
      ...apple,
      APPLE_AUTH_PRIVATE_KEY: undefined,
    }),
  ).toContain("must be configured together");
  expect(
    envApiInvariantViolation({
      ...environment,
      ...apple,
      APPLE_AUTH_PRIVATE_KEY: "not a key",
    }),
  ).toContain("APPLE_AUTH_PRIVATE_KEY must be the PEM text");
});

test("managed checks require an explicit supported provider and bounded configuration", () => {
  for (const provider of [
    undefined,
    ...envApiServerSchema.AI_PROVIDER.wrapped.options,
  ]) {
    const input = {
      ...environment,
      AI_PROVIDER: provider,
      FEATURE_MANAGED_PROVIDER_CHECKS: true,
      OPENROUTER_API_KEY: "fixture-key",
      MANAGED_PROVIDER_CHECK_INTERVAL_MS: 71,
      MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 13,
    };
    expect(envApiInvariantViolation(input)).toBe(
      provider === "openrouter"
        ? null
        : "FEATURE_MANAGED_PROVIDER_CHECKS requires AI_PROVIDER=openrouter.",
    );
    expect(
      envApiInvariantViolation({
        ...input,
        FEATURE_MANAGED_PROVIDER_CHECKS: false,
      }),
    ).toBeNull();
  }
  const supported = {
    ...environment,
    FEATURE_MANAGED_PROVIDER_CHECKS: true,
    AI_PROVIDER: "openrouter" as const,
    OPENROUTER_API_KEY: "fixture-key",
    MANAGED_PROVIDER_CHECK_INTERVAL_MS: 71,
    MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 13,
  };
  expect(
    envApiInvariantViolation({ ...supported, OPENROUTER_API_KEY: undefined }),
  ).toContain("requires OPENROUTER_API_KEY or complete OpenRouter WIF");
  expect(
    envApiInvariantViolation({ ...supported, OPENROUTER_API_KEY: "  " }),
  ).toContain("requires OPENROUTER_API_KEY or complete OpenRouter WIF");
  const wif = {
    OPENROUTER_WIF_POLICY_ID: "fixture-policy",
    OPENROUTER_WIF_AUDIENCE: "fixture-audience",
    OPENROUTER_WIF_STS_REGION: "eu-west-1",
  } satisfies Pick<
    Parameters<typeof envApiInvariantViolation>[0],
    | "OPENROUTER_WIF_POLICY_ID"
    | "OPENROUTER_WIF_AUDIENCE"
    | "OPENROUTER_WIF_STS_REGION"
  >;
  expect(
    envApiInvariantViolation({
      ...supported,
      OPENROUTER_API_KEY: undefined,
      ...wif,
    }),
  ).toBeNull();
  expect(envApiInvariantViolation({ ...supported, ...wif })).toBeNull();
  for (const settings of [
    { MANAGED_PROVIDER_CHECK_INTERVAL_MS: undefined },
    { MANAGED_PROVIDER_CHECK_TIMEOUT_MS: undefined },
    { MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 71 },
    { MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 73 },
  ]) {
    expect(envApiInvariantViolation({ ...supported, ...settings })).toContain(
      "timeout must be shorter than interval",
    );
  }
  expect(
    v.parse(envApiServerSchema.FEATURE_MANAGED_PROVIDER_CHECKS, undefined),
  ).toBe(false);
  for (const schema of [
    envApiServerSchema.MANAGED_PROVIDER_CHECK_INTERVAL_MS,
    envApiServerSchema.MANAGED_PROVIDER_CHECK_TIMEOUT_MS,
  ]) {
    for (const invalid of ["0", "-1", "1.2", "2147483648"]) {
      expect(v.safeParse(schema, invalid).success).toBe(false);
    }
    expect(v.parse(schema, "17")).toBe(17);
  }
});

test("a managed free tier requires an isolated OpenRouter credential", () => {
  const configured = {
    ...environment,
    AI_PROVIDER: "openrouter" as const,
    FEATURE_FREE_TIER: true,
    FEATURE_ORG_ACCESS_STATE: true,
    FEATURE_ORG_SERVICE_BUDGETS: true,
    FEATURE_ACTION_ADMISSION: true,
    ORG_EVALUATION_PERIOD_DAYS: 14,
    FEATURE_MANAGED_PROVIDER_CHECKS: true,
    OPENROUTER_API_KEY: "standard-key",
    MANAGED_PROVIDER_CHECK_INTERVAL_MS: 71,
    MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 13,
  };
  expect(envApiInvariantViolation(configured)).toContain(
    "requires OPENROUTER_FAST_TIER_API_KEY",
  );
  // Catalog checks off: the free floor still runs on managed OpenRouter.
  expect(
    envApiInvariantViolation({
      ...configured,
      FEATURE_MANAGED_PROVIDER_CHECKS: false,
    }),
  ).toContain("requires OPENROUTER_FAST_TIER_API_KEY");
  expect(
    envApiInvariantViolation({
      ...configured,
      OPENROUTER_FAST_TIER_API_KEY: "fast-key",
    }),
  ).toBeNull();
  expect(
    envApiInvariantViolation({
      ...configured,
      OPENROUTER_FAST_TIER_WIF_POLICY_ID: "fast-policy",
      OPENROUTER_WIF_AUDIENCE: "fixture-audience",
      OPENROUTER_WIF_STS_REGION: "eu-west-1",
    }),
  ).toBeNull();
});

test("OpenRouter WIF settings are nonblank and configured as a complete set", () => {
  const wifSchemas = [
    envApiServerSchema.OPENROUTER_WIF_POLICY_ID,
    envApiServerSchema.OPENROUTER_WIF_AUDIENCE,
    envApiServerSchema.OPENROUTER_WIF_STS_REGION,
  ];
  for (const schema of wifSchemas) {
    for (const invalid of ["", "   "]) {
      expect(v.safeParse(schema, invalid).success).toBe(false);
    }
  }
  for (const invalid of ["aws-global", "https://sts.amazonaws.com", "region"]) {
    expect(
      v.safeParse(envApiServerSchema.OPENROUTER_WIF_STS_REGION, invalid)
        .success,
    ).toBe(false);
  }

  const wif = {
    OPENROUTER_WIF_POLICY_ID: "fixture-policy",
    OPENROUTER_WIF_AUDIENCE: "fixture-audience",
    OPENROUTER_WIF_STS_REGION: "eu-west-1",
  } satisfies Pick<
    Parameters<typeof envApiInvariantViolation>[0],
    | "OPENROUTER_WIF_POLICY_ID"
    | "OPENROUTER_WIF_AUDIENCE"
    | "OPENROUTER_WIF_STS_REGION"
  >;
  const partialConfigurations = [
    { OPENROUTER_WIF_POLICY_ID: wif.OPENROUTER_WIF_POLICY_ID },
    { OPENROUTER_WIF_AUDIENCE: wif.OPENROUTER_WIF_AUDIENCE },
    { OPENROUTER_WIF_STS_REGION: wif.OPENROUTER_WIF_STS_REGION },
    {
      OPENROUTER_WIF_POLICY_ID: wif.OPENROUTER_WIF_POLICY_ID,
      OPENROUTER_WIF_AUDIENCE: wif.OPENROUTER_WIF_AUDIENCE,
    },
    {
      OPENROUTER_WIF_POLICY_ID: wif.OPENROUTER_WIF_POLICY_ID,
      OPENROUTER_WIF_STS_REGION: wif.OPENROUTER_WIF_STS_REGION,
    },
    {
      OPENROUTER_WIF_AUDIENCE: wif.OPENROUTER_WIF_AUDIENCE,
      OPENROUTER_WIF_STS_REGION: wif.OPENROUTER_WIF_STS_REGION,
    },
  ] satisfies Pick<
    Parameters<typeof envApiInvariantViolation>[0],
    | "OPENROUTER_WIF_POLICY_ID"
    | "OPENROUTER_WIF_AUDIENCE"
    | "OPENROUTER_WIF_STS_REGION"
  >[];
  const base = {
    ...environment,
    AI_PROVIDER: "openrouter",
    FEATURE_MANAGED_PROVIDER_CHECKS: false,
    OPENROUTER_API_KEY: "fixture-key",
  } satisfies Parameters<typeof envApiInvariantViolation>[0];
  for (const partial of partialConfigurations) {
    expect(envApiInvariantViolation({ ...base, ...partial })).toContain(
      "must be configured together",
    );
    expect(
      envApiInvariantViolation({
        ...base,
        FEATURE_MANAGED_PROVIDER_CHECKS: true,
        ...partial,
      }),
    ).toContain("must be configured together");
  }
});

test("catalog check deadlines have a bounded operator ceiling", () => {
  expect(
    v.parse(envApiServerSchema.MANAGED_PROVIDER_CHECK_TIMEOUT_MS, "30000"),
  ).toBe(30_000);
  expect(
    v.safeParse(envApiServerSchema.MANAGED_PROVIDER_CHECK_TIMEOUT_MS, "30001")
      .success,
  ).toBe(false);
  expect(
    v.parse(
      envApiServerSchema.MANAGED_PROVIDER_CHECK_INTERVAL_MS,
      "2147483647",
    ),
  ).toBe(2_147_483_647);
});

test("Microsoft claim configuration defaults to disabled", () => {
  const schema = envApiServerSchema.MICROSOFT_REQUIRE_VERIFIED_EMAIL_CLAIM;
  expect(v.parse(schema, undefined)).toBe(false);
  expect(v.parse(schema, "false")).toBe(false);
  expect(v.parse(schema, "true")).toBe(true);
  expect(v.safeParse(schema, "invalid").success).toBe(false);
});

test("registration settings supply bounded operator defaults", () => {
  for (const { schema, defaultValue, maximum } of [
    {
      schema: envApiServerSchema.UNUSED_CLIENT_RETENTION_DAYS,
      defaultValue: 30,
      maximum: 365,
    },
    {
      schema: envApiServerSchema.AGENT_REGISTRATION_DAILY_LIMIT,
      defaultValue: 10_000,
      maximum: 1_000_000,
    },
    {
      schema: envApiServerSchema.OPEN_CLIENT_REGISTRATION_DAILY_LIMIT,
      defaultValue: 10_000,
      maximum: 1_000_000,
    },
  ]) {
    expect(v.parse(schema, undefined)).toBe(defaultValue);
    for (const valid of [1, 7, maximum]) {
      expect(v.parse(schema, String(valid))).toBe(valid);
    }
    for (const invalid of ["0", "-1", "1.2", "text", String(maximum + 1)]) {
      expect(v.safeParse(schema, invalid).success).toBe(false);
    }
  }
});

test("the client address header cannot reuse a header the API owns", () => {
  const schema = envApiServerSchema.STELLA_CLIENT_ADDRESS_HEADER;
  for (const name of ["x-stella-client-address", "X-Stella-Origin-Verify"]) {
    expect(v.safeParse(schema, name).success).toBe(false);
  }
  expect(v.safeParse(schema, "cloudfront-viewer-address").success).toBe(true);
});

test("origin verify values are single values of at least 32 characters", () => {
  const current = "a".repeat(32);
  const previous = "b".repeat(32);
  for (const schema of [
    envApiServerSchema.STELLA_ORIGIN_VERIFY_SECRET,
    envApiServerSchema.STELLA_ORIGIN_VERIFY_SECRET_PREVIOUS,
  ]) {
    expect(v.safeParse(schema, undefined).success).toBe(true);
    expect(v.safeParse(schema, current).success).toBe(true);
    expect(v.safeParse(schema, previous).success).toBe(true);
    expect(v.parse(schema, `${current}\n`)).toBe(current);
    expect(v.parse(schema, ` ${previous} `)).toBe(previous);
    for (const invalid of [
      "a".repeat(31),
      `${"a".repeat(31)}\n`,
      `${current},${previous}`,
    ]) {
      expect(v.safeParse(schema, invalid).success).toBe(false);
    }
  }
});

test("inbound mail receiving is configured all-or-none and requires its domain", () => {
  const transport = [
    [
      "INBOUND_MAIL_QUEUE_URL",
      "https://sqs.eu-west-1.amazonaws.com/123456789012/inbound-mail",
    ],
    [
      "INBOUND_MAIL_TOPIC_ARN",
      "arn:aws:sns:eu-west-1:123456789012:inbound-mail",
    ],
    ["INBOUND_MAIL_BUCKET", "inbound-mail-bucket"],
    ["INBOUND_MAIL_KEY_PREFIX", "mail/"],
  ] as const;
  let subsets: (typeof transport)[number][][] = [[]];
  for (const entry of transport) {
    subsets = subsets.flatMap((subset) => [subset, subset.concat([entry])]);
  }
  expect(subsets).toHaveLength(2 ** transport.length);
  for (const subset of subsets) {
    for (const domain of [undefined, "inbound.example.test"]) {
      const violation = envApiInvariantViolation({
        ...environment,
        ...Object.fromEntries(subset),
        INBOUND_MAIL_DOMAIN: domain,
      });
      expect(violation === null).toBe(
        subset.length === 0 ||
          (subset.length === transport.length && domain !== undefined),
      );
    }
  }
  for (const [name, value] of transport) {
    expect(v.safeParse(envApiServerSchema[name], value).success).toBe(true);
  }
  for (const [name, invalid] of [
    ["INBOUND_MAIL_QUEUE_URL", "http://sqs.example.test/queue"],
    ["INBOUND_MAIL_TOPIC_ARN", "arn:aws:sqs:eu-west-1:123456789012:inbound"],
    ["INBOUND_MAIL_BUCKET", "Inbound_Bucket"],
  ] as const) {
    expect(v.safeParse(envApiServerSchema[name], invalid).success).toBe(false);
  }
});

test("list verification grants use the shared registered-feature configuration", () => {
  expect(
    v.parse(
      envBaseServerSchema.API_FEATURE_ACCESS_GRANTS,
      JSON.stringify({
        "list-verification": [
          {
            type: "member",
            organizationId: "org-a",
            email: " Member@Example.test ",
          },
        ],
      }),
    ),
  ).toEqual({
    unknownGrantCount: 0,
    grants: {
      "list-verification": [
        {
          type: "member",
          organizationId: "org-a",
          email: "member@example.test",
        },
      ],
    },
  });
  expect(
    v.safeParse(
      envBaseServerSchema.API_FEATURE_ACCESS_GRANTS,
      '{"list-verification":[{"type":"member","organizationId":"org-a","email":"*@example.test"}]}',
    ).success,
  ).toBe(false);
});

test("the free tier boots only with access state and service budgets, and never with usage enforcement", () => {
  expect(v.parse(envApiServerSchema.FEATURE_FREE_TIER, undefined)).toBe(false);
  for (const FEATURE_FREE_TIER of [false, true]) {
    for (const FEATURE_ORG_ACCESS_STATE of [false, true]) {
      for (const FEATURE_ORG_SERVICE_BUDGETS of [false, true]) {
        for (const USAGE_ENFORCEMENT_ENABLED of [false, true]) {
          const bootable =
            !FEATURE_FREE_TIER ||
            (FEATURE_ORG_ACCESS_STATE &&
              FEATURE_ORG_SERVICE_BUDGETS &&
              !USAGE_ENFORCEMENT_ENABLED);
          const violation = freeTierInvariantViolation({
            FEATURE_FREE_TIER,
            FEATURE_ORG_ACCESS_STATE,
            FEATURE_ORG_SERVICE_BUDGETS,
            USAGE_ENFORCEMENT_ENABLED,
          });
          expect(violation === null).toBe(bootable);
          if (violation !== null) {
            expect(violation).toStartWith("FEATURE_FREE_TIER requires");
          }
        }
      }
    }
  }
});

test("visual preview configuration accepts an optional Lambda function identifier", () => {
  const schema = envApiServerSchema.VISUAL_PREVIEW_FUNCTION_NAME;
  expect(v.parse(schema, undefined)).toBeUndefined();
  for (const arn of ["visual-preview-test", "visual-preview-test:live"]) {
    expect(v.parse(schema, arn)).toBe(arn);
  }
  for (const value of [
    "https://example.test/preview",
    "arn:aws:s3:::preview",
    "arn:aws:lambda:eu-central-1:123:function:preview",
  ]) {
    expect(v.safeParse(schema, value).success).toBe(false);
  }
});

test("monitoring session keys accept a bounded digest configuration", () => {
  const schema = envApiServerSchema.SYNTHETIC_SESSION_KEYS;
  const entry = {
    label: "current",
    sha256: "a".repeat(64),
    notAfter: "2026-10-20T12:00:00Z",
  };
  expect(v.parse(schema, undefined)).toBeUndefined();
  expect(v.parse(schema, JSON.stringify([entry]))).toEqual([entry]);
  expect(
    v.parse(schema, JSON.stringify([entry, { ...entry, label: "next" }])),
  ).toHaveLength(2);
  for (const invalid of [
    "invalid",
    "[]",
    JSON.stringify([entry, entry, entry]),
    JSON.stringify([{ ...entry, sha256: "short" }]),
    JSON.stringify([{ ...entry, notAfter: "tomorrow" }]),
    JSON.stringify([{ ...entry, label: "" }]),
  ]) {
    expect(v.safeParse(schema, invalid).success).toBe(false);
  }
});

test("deployment environment is optional and accepts only declared deployment kinds", () => {
  const schema = envApiServerSchema.DEPLOY_ENVIRONMENT;
  for (const kind of ["production", "staging", "development"] as const) {
    expect(v.parse(schema, kind)).toBe(kind);
  }
  expect(v.parse(schema, undefined)).toBeUndefined();
  for (const invalid of ["", "test", "prod"] as const) {
    expect(v.safeParse(schema, invalid).success).toBe(false);
  }
  expect(schema).toBe(envBaseServerSchema.DEPLOY_ENVIRONMENT);
});
