import { expect, test } from "bun:test";

import { resolveScopedFeatureIds } from "@/api/db/scoped-feature-access";
import { env } from "@/api/env";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";

const grant = { type: "organization", organizationId: "fixture-org" } as const;

test("authenticated feature scope derives the complete prerequisite grant decision", async () => {
  const previous = env.API_FEATURE_ACCESS_GRANTS;
  try {
    for (const featureIds of [
      [],
      [LEGAL_LISTS_FEATURE_ID],
      [LIST_VERIFICATION_FEATURE_ID],
      [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
    ]) {
      env.API_FEATURE_ACCESS_GRANTS = Object.fromEntries(
        featureIds.map((id) => [id, [grant]]),
      );
      let queries = 0;
      const tx = {
        execute: async () => {
          queries += 1;
          return [{ email: "member@example.test", emailVerified: true }];
        },
      };
      const actual = await resolveScopedFeatureIds({
        tx,
        organizationId: grant.organizationId,
        userId: "fixture-user",
      });
      const expected = featureIds.includes(LEGAL_LISTS_FEATURE_ID)
        ? featureIds
        : [];
      expect(actual).toEqual(expected);
      expect(queries).toBe(expected.length === 0 ? 0 : 1);
    }
    env.API_FEATURE_ACCESS_GRANTS = { [LEGAL_LISTS_FEATURE_ID]: [grant] };
    for (const identity of [
      [],
      [{ email: "member@example.test", emailVerified: false }],
    ]) {
      expect(
        await resolveScopedFeatureIds({
          tx: { execute: async () => identity },
          organizationId: grant.organizationId,
          userId: "fixture-user",
        }),
      ).toEqual([]);
    }
    let serviceQueries = 0;
    expect(
      await resolveScopedFeatureIds({
        tx: {
          execute: async () => {
            serviceQueries += 1;
            return [];
          },
        },
        organizationId: grant.organizationId,
        userId: null,
      }),
    ).toEqual([]);
    expect(serviceQueries).toBe(0);
  } finally {
    env.API_FEATURE_ACCESS_GRANTS = previous;
  }
});
