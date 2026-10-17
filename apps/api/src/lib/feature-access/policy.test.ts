import { expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import type {
  FeatureAccessGrants,
  FeatureGrant,
} from "@/api/lib/feature-access/grants-schema";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
  hasFeatureAccess,
  isFeatureEnabled,
} from "@/api/lib/feature-access/policy";
import type { FeatureAccessDecision } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  type FeatureRegistry,
} from "@/api/lib/feature-access/registry";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

const registry = {
  "fixture-invitation": { enrolment: "invitation" },
  "fixture-self-serve": { enrolment: "self-serve" },
} as const satisfies FeatureRegistry;
const memberGrant = {
  type: "member",
  organizationId: "org-a",
  email: "member@example.test",
} as const satisfies FeatureGrant;
const organizationGrant = {
  type: "organization",
  organizationId: "org-a",
} as const satisfies FeatureGrant;

test("invitation access requires matching grants, a verified identity, and current membership", () => {
  for (const grant of [null, memberGrant, organizationGrant]) {
    const grants = {
      "fixture-invitation": grant === null ? [] : [grant],
    } satisfies FeatureAccessGrants;
    for (const organizationId of ["org-a", "org-b"]) {
      for (const email of ["member@example.test", "colleague@example.test"]) {
        for (const emailVerified of [false, true]) {
          for (const membership of [false, true]) {
            const decision = decideFeatureAccess({
              userId: "user-a",
              registry,
              grants,
              featureId: "fixture-invitation",
              organizationId,
              user: { email, emailVerified },
              membership,
            });
            expect(decision.status).toBe(
              grant !== null &&
                organizationId === "org-a" &&
                emailVerified &&
                membership &&
                (grant.type === "organization" ||
                  email === "member@example.test")
                ? "enabled"
                : "hidden",
            );
          }
        }
      }
    }
  }
});

test("missing identities and grants for another feature remain hidden", () => {
  const grants = { "fixture-self-serve": [memberGrant] };
  for (const user of [
    null,
    { email: "member@example.test", emailVerified: true },
  ]) {
    expect(
      decideFeatureAccess({
        userId: "user-a",
        registry,
        grants,
        featureId: "fixture-invitation",
        organizationId: "org-a",
        user,
        membership: true,
      }).status,
    ).toBe("hidden");
  }
});

test("enabled access carries an opaque proof bound to the feature and organization", () => {
  const decision = decideFeatureAccess({
    userId: "user-a",
    registry,
    grants: { "fixture-invitation": [memberGrant] },
    featureId: "fixture-invitation",
    organizationId: "org-a",
    user: { email: " Member@Example.Test ", emailVerified: true },
    membership: true,
  });
  expect(decision.status).toBe("enabled");
  if (decision.status === "enabled") {
    expect(decision.proof.featureId).toBe("fixture-invitation");
    expect(decision.proof.organizationId).toBe("org-a");
    expect(decision.proof.userId).toBe("user-a");
    expect(JSON.stringify(decision.proof)).not.toContain("member@example.test");
  }
});

test("feature snapshots cannot transfer enabled decisions across users, organizations, or feature keys", () => {
  const principal = { organizationId: "org-a", userId: "user-a" };
  const enabled = decideFeatureAccess({
    ...principal,
    registry,
    grants: { "fixture-invitation": [memberGrant] },
    featureId: "fixture-invitation",
    user: { email: "member@example.test", emailVerified: true },
    membership: true,
  });
  const decisions = new Map([["fixture-invitation", enabled]]);
  const snapshot = createFeatureAccessSnapshot({ ...principal, decisions });
  expect(isFeatureEnabled(snapshot, "fixture-invitation", principal)).toBe(
    true,
  );
  for (const otherPrincipal of [
    { organizationId: "org-b", userId: "user-a" },
    { organizationId: "org-a", userId: "user-b" },
    { organizationId: "org-a", userId: null },
  ]) {
    expect(
      isFeatureEnabled(snapshot, "fixture-invitation", otherPrincipal),
    ).toBe(false);
    expect(() =>
      createFeatureAccessSnapshot({ ...otherPrincipal, decisions }),
    ).toThrow(
      "Feature access snapshot decisions must match their principal and feature",
    );
  }
  expect(() =>
    createFeatureAccessSnapshot({
      ...principal,
      decisions: new Map([["fixture-self-serve", enabled]]),
    }),
  ).toThrow(
    "Feature access snapshot decisions must match their principal and feature",
  );
  decisions.set("fixture-self-serve", enabled);
  expect(isFeatureEnabled(snapshot, "fixture-self-serve", principal)).toBe(
    false,
  );
});

test("self-serve access requires a deployment offer and an enrolment bound to the verified current member", () => {
  for (const deploymentEnabled of [false, true]) {
    for (const emailVerified of [false, true]) {
      for (const membership of [false, true]) {
        for (const organizationId of ["org-a", "org-b"]) {
          for (const userId of ["user-a", "user-b", null]) {
            for (const featureId of [
              "fixture-self-serve",
              "fixture-invitation",
            ]) {
              const decision = decideFeatureAccess({
                userId,
                registry,
                grants: {},
                featureId,
                organizationId,
                user: { email: "member@example.test", emailVerified },
                membership,
                deploymentEnabled,
                enrolments: [
                  {
                    featureId: "fixture-self-serve",
                    organizationId: "org-a",
                    userId: "user-a",
                  },
                ],
              });
              expect(decision.status).toBe(
                deploymentEnabled &&
                  emailVerified &&
                  membership &&
                  organizationId === "org-a" &&
                  userId === "user-a" &&
                  featureId === "fixture-self-serve"
                  ? "enabled"
                  : "hidden",
              );
            }
          }
        }
      }
    }
  }
});

test("unknown policy declarations are invariants while absent discovery decisions stay hidden", () => {
  expect(() =>
    decideFeatureAccess({
      userId: "user-a",
      registry,
      grants: {},
      featureId: "unknown-feature",
      organizationId: "org-a",
      user: null,
      membership: false,
    }),
  ).toThrow("Feature access requires a registered feature");
  const enabled = decideFeatureAccess({
    userId: "user-a",
    registry,
    grants: { "fixture-invitation": [memberGrant] },
    featureId: "fixture-invitation",
    organizationId: "org-a",
    user: { email: "member@example.test", emailVerified: true },
    membership: true,
  });
  const decisions = new Map<string, FeatureAccessDecision>([
    ["fixture-invitation", enabled],
    ["fixture-self-serve", { status: "hidden" }],
  ]);
  const principal = { organizationId: "org-a", userId: "user-a" };
  const snapshot = createFeatureAccessSnapshot({ ...principal, decisions });
  expect(isFeatureEnabled(snapshot, undefined, principal)).toBe(true);
  expect(isFeatureEnabled(snapshot, "fixture-invitation", principal)).toBe(
    true,
  );
  expect(isFeatureEnabled(snapshot, "fixture-self-serve", principal)).toBe(
    false,
  );
  expect(isFeatureEnabled(snapshot, "unknown-feature", principal)).toBe(false);
});

test("caller proof remains distinct from a live deployment refusal", () => {
  const principal = { organizationId: "org-a", userId: "user-a" };
  const decision = decideFeatureAccess({
    ...principal,
    registry: FEATURE_REGISTRY,
    grants: {},
    featureId: "signals",
    membership: true,
    user: { email: "member@example.test", emailVerified: true },
    enrolments: [{ ...principal, featureId: "signals" }],
  });
  const snapshot = createFeatureAccessSnapshot({
    ...principal,
    decisions: new Map([["signals", decision]]),
  });
  const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  try {
    for (const enabled of [false, true]) {
      testState.setConfig("FEATURE_SIGNALS", enabled);
      expect(hasFeatureAccess(snapshot, "signals", principal)).toBe(true);
      expect(isFeatureEnabled(snapshot, "signals", principal)).toBe(enabled);
      const foreignPrincipal = { ...principal, userId: "another-user" };
      expect(hasFeatureAccess(snapshot, "signals", foreignPrincipal)).toBe(
        false,
      );
      expect(isFeatureEnabled(snapshot, "signals", foreignPrincipal)).toBe(
        false,
      );
    }
  } finally {
    restore();
  }
});
