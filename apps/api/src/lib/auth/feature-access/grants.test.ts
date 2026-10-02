import { expect, test } from "bun:test";
import * as v from "valibot";

import { createFeatureAccessGrantsEnvSchema } from "@/api/lib/auth/feature-access/grants";
import type { FeatureRegistry } from "@/api/lib/auth/feature-access/registry";

const registry = {
  "fixture-invitation": { enrolment: "invitation" },
  "fixture-self-serve": { enrolment: "self-serve" },
} as const satisfies FeatureRegistry;
const schema = createFeatureAccessGrantsEnvSchema(registry);

test("feature grants default to an empty object and normalize explicit member identities", () => {
  expect(v.parse(schema, undefined)).toEqual({});
  expect(v.parse(schema, "{}")).toEqual({});
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
    "fixture-invitation": [
      { type: "member", organizationId: "org-a", email: "member@example.test" },
      { type: "organization", organizationId: "org-b" },
    ],
  });
});

test("feature grant validation rejects unknown keys and malformed shapes without grant identities", () => {
  for (const raw of [
    "not-json",
    "null",
    "[]",
    '{"unknown-feature":[]}',
    '{"__proto__":[]}',
    '{"constructor":[]}',
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
