import { expect, test } from "bun:test";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import { envApiInvariantViolation, envApiServerSchema } from "./env-schema";

test("agent client storage format requires explicit enablement", () => {
  const schema = envApiServerSchema.AGENT_CLIENT_STORAGE_V1_ENABLED;
  expect(v.parse(schema, undefined)).toBe(false);
  expect(v.parse(schema, "false")).toBe(false);
  expect(v.parse(schema, "true")).toBe(true);
});

test("feature access grants default to empty and discard unknown production feature ids", () => {
  const schema = envApiServerSchema.API_FEATURE_ACCESS_GRANTS;
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
  expect(v.safeParse(schema, "x-stella-viewer-address").success).toBe(true);
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
      envApiServerSchema.API_FEATURE_ACCESS_GRANTS,
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
      envApiServerSchema.API_FEATURE_ACCESS_GRANTS,
      '{"list-verification":[{"type":"member","organizationId":"org-a","email":"*@example.test"}]}',
    ).success,
  ).toBe(false);
});
