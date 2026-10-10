import { expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { resolveScopedFeatureIds } from "@/api/db/scoped-feature-access";
import { env } from "@/api/env";
import { buildFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { toSafeId } from "@/api/lib/branded-types";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

const grant = { type: "organization", organizationId: "fixture-org" } as const;
const memberIdentity = { email: "member@example.test", emailVerified: true };
const GRANT_SETS: readonly (readonly string[])[] = [
  [],
  [LEGAL_LISTS_FEATURE_ID],
  [LIST_VERIFICATION_FEATURE_ID],
  [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
];

const verifiedMemberTx = { execute: async () => [memberIdentity] };

const resolveForMember = async () =>
  await resolveScopedFeatureIds({
    tx: verifiedMemberTx,
    organizationId: grant.organizationId,
    userId: "fixture-user",
  });

/** Runs `fn` with the given runtime mode, legal-lists flag and grants. */
const withDeployment = async (
  options: {
    mode: (typeof RUNTIME_MODE)[keyof typeof RUNTIME_MODE];
    legalLists: boolean;
    featureIds: readonly string[];
  },
  fn: () => Promise<void>,
) => {
  const restoreMode = setRuntimeModeForTesting({ mode: options.mode });
  try {
    testState.setConfig("FEATURE_LEGAL_LISTS", options.legalLists);
    testState.setConfig(
      "API_FEATURE_ACCESS_GRANTS",
      Object.fromEntries(options.featureIds.map((id) => [id, [grant]])),
    );
    await fn();
  } finally {
    restoreMode();
  }
};

test("authenticated feature scope derives the complete prerequisite grant decision", async () => {
  for (const featureIds of [
    [],
    [LEGAL_LISTS_FEATURE_ID],
    [LIST_VERIFICATION_FEATURE_ID],
    [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
  ]) {
    testState.setConfig(
      "API_FEATURE_ACCESS_GRANTS",
      Object.fromEntries(featureIds.map((id) => [id, [grant]])),
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
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    [LEGAL_LISTS_FEATURE_ID]: [grant],
  });
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
});

test("a disabled legal-lists deployment admits neither the feature nor its dependants", async () => {
  await withDeployment(
    {
      mode: RUNTIME_MODE.strict,
      legalLists: false,
      featureIds: [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
    },
    async () => {
      expect(await resolveForMember()).toEqual([]);
    },
  );
  await withDeployment(
    {
      mode: RUNTIME_MODE.strict,
      legalLists: true,
      featureIds: [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
    },
    async () => {
      expect(await resolveForMember()).toEqual([
        LEGAL_LISTS_FEATURE_ID,
        LIST_VERIFICATION_FEATURE_ID,
      ]);
    },
  );
});

test("the database scope and the request snapshot make the same decision", async () => {
  for (const mode of [RUNTIME_MODE.strict, RUNTIME_MODE.open]) {
    for (const legalLists of [false, true]) {
      for (const featureIds of GRANT_SETS) {
        await withDeployment({ mode, legalLists, featureIds }, async () => {
          const snapshot = buildFeatureAccessSnapshot({
            organizationId: toSafeId<"organization">(grant.organizationId),
            userId: "fixture-user",
            identity: memberIdentity,
            enrolments: [],
          });
          const snapshotEnabled = [...snapshot.decisions]
            .filter(([, decision]) => decision.status === "enabled")
            .map(([featureId]) => featureId);
          const scoped = await resolveForMember();
          expect(scoped).toEqual(snapshotEnabled);
          const deployed = mode === RUNTIME_MODE.open || legalLists;
          expect(scoped).toEqual(
            deployed && featureIds.includes(LEGAL_LISTS_FEATURE_ID)
              ? [...featureIds]
              : [],
          );
        });
      }
    }
  }
});
