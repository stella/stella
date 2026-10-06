import { expect, test } from "bun:test";
import * as v from "valibot";

import { createFeatureAccessGrantsEnvSchema } from "@/api/lib/feature-access/grants-schema";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";

const registry = {
  "fixture-invitation": { enrolment: "invitation" },
  "fixture-self-serve": { enrolment: "self-serve" },
} as const satisfies FeatureRegistry;
const schema = createFeatureAccessGrantsEnvSchema(registry);

test("feature grants default to an empty object and normalize explicit member identities", () => {
  expect(v.parse(schema, undefined)).toEqual({
    grants: {},
    unknownGrantCount: 0,
  });
  expect(v.parse(schema, "{}")).toEqual({ grants: {}, unknownGrantCount: 0 });
  expect(
    v.parse(
      schema,
      JSON.stringify({
        "fixture-invitation": [
          {
            type: "member",
            organizationId: "org-a",
            email: " Member@Example.Test ",
          },
          { type: "organization", organizationId: "org-b" },
        ],
      }),
    ),
  ).toEqual({
    unknownGrantCount: 0,
    grants: {
      "fixture-invitation": [
        {
          type: "member",
          organizationId: "org-a",
          email: "member@example.test",
        },
        { type: "organization", organizationId: "org-b" },
      ],
    },
  });
});

test("feature grant validation rejects malformed JSON and shapes without grant identities", () => {
  for (const raw of [
    "not-json",
    "null",
    "[]",
    '{"unknown-feature":{}}',
    '{"__proto__":{}}',
    '{"constructor":[{"type":"organization","organizationId":"*"}]}',
    '{"unknown-feature":[{"type":"organization","organizationId":"*"}]}',
    '{"fixture-invitation":{}}',
    '{"fixture-invitation":[{"type":"member","email":"member@example.test"}]}',
    '{"fixture-invitation":[{"type":"member","organizationId":"org-a","email":"*@example.test"}]}',
    '{"fixture-invitation":[{"type":"member","organizationId":"org-a","email":"example.test"}]}',
    '{"fixture-invitation":[{"type":"organization","organizationId":"*"}]}',
    '{"fixture-invitation":[{"type":"organization","organizationId":"org-a","email":"member@example.test"}]}',
    '{"fixture-invitation":[{"type":"global","email":"member@example.test"}]}',
  ]) {
    const result = v.safeParse(schema, raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).not.toContain(
        "member@example.test",
      );
    }
  }
});

for (const unknownFeature of ["unknown-feature", "__proto__", "constructor"]) {
  test(`feature grants discard ${unknownFeature} and retain every registered feature`, () => {
    const knownGrants = Object.fromEntries(
      Object.keys(registry).map((featureId) => [
        featureId,
        [{ type: "organization", organizationId: "org-a" }],
      ]),
    );
    expect(
      v.parse(
        schema,
        JSON.stringify({
          ...knownGrants,
          [unknownFeature]: [
            {
              type: "member",
              organizationId: "org-b",
              email: "member@example.test",
            },
          ],
        }),
      ),
    ).toEqual({ grants: knownGrants, unknownGrantCount: 1 });
  });
}

test("feature grants boot logs only the discarded count and exposes known grants", () => {
  const knownGrants = Object.fromEntries(
    Object.keys(FEATURE_REGISTRY).map((featureId) => [
      featureId,
      [{ type: "organization", organizationId: "org-a" }],
    ]),
  );
  const envPath = new URL("../../env.ts", import.meta.url).pathname;
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { env } = await import(${JSON.stringify(envPath)}); process.stdout.write(JSON.stringify(env.API_FEATURE_ACCESS_GRANTS));`,
    ],
    {
      env: {
        ...process.env,
        LOGS_OTLP_URL: "",
        LOGS_OTLP_TOKEN: "",
        API_FEATURE_ACCESS_GRANTS: JSON.stringify({
          ...knownGrants,
          "unknown-feature": [
            {
              type: "member",
              organizationId: "org-private",
              email: "private@example.test",
            },
          ],
          "another-unknown": [],
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.stderr.toString()).toContain(
    '"message":"feature_access.unknown_grant"',
  );
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual(knownGrants);
  const records = child.stderr
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toEqual([
    {
      severity: "ERROR",
      message: "feature_access.unknown_grant",
      "feature_access.unknown_grant_count": 2,
    },
  ]);
});

for (const raw of ["not-json", "null", '{"unknown-feature":{}}']) {
  test(`feature grants boot rejects malformed configuration ${raw}`, () => {
    const envPath = new URL("../../env.ts", import.meta.url).pathname;
    const child = Bun.spawnSync(
      [process.execPath, "-e", `await import(${JSON.stringify(envPath)});`],
      {
        env: {
          ...process.env,
          API_FEATURE_ACCESS_GRANTS: raw,
          LOGS_OTLP_URL: "",
          LOGS_OTLP_TOKEN: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toContain(
      "API_FEATURE_ACCESS_GRANTS must be a JSON object of feature grants",
    );
    expect(child.stderr.toString()).not.toContain(
      '"message":"feature_access.unknown_grant"',
    );
  });
}
