import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import {
  AUDIT_DETAIL_POLICY,
  projectAuditReadChanges,
} from "@/api/lib/audit-log-details";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

const PRINCIPAL = { organizationId: "org_test", userId: "user_test" };
const CHANGES = { amount: { old: 100, new: 200 } };

const missingClassifications = (
  resources: readonly string[],
  policies: Readonly<Record<string, unknown>>,
) => resources.filter((resource) => !Object.hasOwn(policies, resource));

describe("audit detail policy census", () => {
  test("classifies every audited resource exactly once", () => {
    const resources = Object.values(AUDIT_RESOURCE_TYPE);
    expect(missingClassifications(resources, AUDIT_DETAIL_POLICY)).toEqual([]);
    expect(Object.keys(AUDIT_DETAIL_POLICY).toSorted()).toEqual(
      resources.toSorted(),
    );
  });

  test("detects an omitted resource classification", () => {
    const { [AUDIT_RESOURCE_TYPE.TIME_ENTRY]: _omitted, ...incomplete } =
      AUDIT_DETAIL_POLICY;
    expect(
      missingClassifications(Object.values(AUDIT_RESOURCE_TYPE), incomplete),
    ).toEqual([AUDIT_RESOURCE_TYPE.TIME_ENTRY]);
  });

  test("requires a classification for a stored resource", () => {
    expect(() =>
      projectAuditReadChanges({
        resourceType: "unclassified_resource",
        changes: CHANGES,
        featureAccessSnapshot: undefined,
        principal: PRINCIPAL,
      }),
    ).toThrow("Audit resource requires a detail policy");
  });

  for (const [resourceType, policy] of Object.entries(AUDIT_DETAIL_POLICY)) {
    test(`${resourceType} follows its declared detail policy`, () => {
      const input = {
        resourceType,
        changes: CHANGES,
        featureAccessSnapshot: undefined,
        principal: PRINCIPAL,
      };
      switch (policy.type) {
        case "ungated":
          expect(projectAuditReadChanges(input)).toEqual({
            changesStatus: "visible",
            changes: resourceType.startsWith("chat_") ? {} : CHANGES,
          });
          return;
        case "caller-feature": {
          expect(projectAuditReadChanges(input)).toEqual({
            changesStatus: "feature_unavailable",
            changes: null,
          });
          expect(
            projectAuditReadChanges({
              ...input,
              featureAccessSnapshot: createFeatureAccessSnapshot({
                ...PRINCIPAL,
                decisions: new Map([[policy.featureId, { status: "hidden" }]]),
              }),
            }),
          ).toEqual({ changesStatus: "feature_unavailable", changes: null });
          const featureAccessSnapshot = createFeatureAccessSnapshot({
            ...PRINCIPAL,
            decisions: new Map([
              [
                policy.featureId,
                decideFeatureAccess({
                  ...PRINCIPAL,
                  registry: FEATURE_REGISTRY,
                  grants: {
                    [policy.featureId]: [
                      {
                        type: "organization",
                        organizationId: PRINCIPAL.organizationId,
                      },
                    ],
                  },
                  featureId: policy.featureId,
                  user: { email: "test@example.test", emailVerified: true },
                  membership: true,
                  enrolments: [{ ...PRINCIPAL, featureId: policy.featureId }],
                }),
              ],
            ]),
          });
          expect(
            projectAuditReadChanges({ ...input, featureAccessSnapshot }),
          ).toEqual({
            changesStatus: "visible",
            changes: CHANGES,
          });
          return;
        }
        case "deployment-feature": {
          const previous = env[policy.feature];
          const restoreMode = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          try {
            env[policy.feature] = false;
            expect(projectAuditReadChanges(input)).toEqual({
              changesStatus: "feature_unavailable",
              changes: null,
            });
            env[policy.feature] = true;
            expect(projectAuditReadChanges(input)).toEqual({
              changesStatus: "visible",
              changes: CHANGES,
            });
          } finally {
            env[policy.feature] = previous;
            restoreMode();
          }
          return;
        }
        default:
          policy satisfies never;
      }
    });
  }
});
