import { describe, expect, test } from "bun:test";

import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";
import type { AuditResourceType } from "@/api/lib/audit-log.constants";
import { toSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mapHandlerResult } from "@/api/mcp/capability-tools";
import type { McpRequestContext } from "@/api/mcp/context";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch/audit-logs.list";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { serializeToolResult } from "@/api/mcp/tool-utils";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import exportAuditLogs from "./export";
import readAuditLogs from "./list";

const PRINCIPAL = {
  organizationId: toSafeId<"organization">("org_test"),
  userId: toSafeId<"user">("user_test"),
};
const CREATED_AT = new Date("2026-07-16T12:00:00.000Z");
const CHANGES = { amount: { old: 100, new: 200 } };
const BILLING_RESOURCES = [
  AUDIT_RESOURCE_TYPE.BILLING_CODE,
  AUDIT_RESOURCE_TYPE.EXPENSE,
  AUDIT_RESOURCE_TYPE.INVOICE,
  AUDIT_RESOURCE_TYPE.NUMBER_SERIES,
  AUDIT_RESOURCE_TYPE.RATE_ENTRY,
  AUDIT_RESOURCE_TYPE.RATE_TABLE,
  AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE,
  AUDIT_RESOURCE_TYPE.SELLER_PROFILE,
  AUDIT_RESOURCE_TYPE.TIME_DAILY_TARGET,
  AUDIT_RESOURCE_TYPE.TIME_ENTRY,
  AUDIT_RESOURCE_TYPE.TIME_TIMER,
  AUDIT_RESOURCE_TYPE.VAT_RATE,
] as const;

type AuditFixtureOptions = {
  resourceType: AuditResourceType;
  enrolled: boolean;
  operation?: string;
  featureId?: "time-billing" | "list-verification";
};

const contextFor = ({
  resourceType,
  enrolled,
  operation,
  featureId = "time-billing",
}: AuditFixtureOptions) => {
  let selects = 0;
  const { safeDb } = createScopedDbMock({
    select: () => {
      selects += 1;
      if (selects === 1) {
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  {
                    id: toSafeId<"auditLog">(
                      "00000000-0000-4000-8000-000000000001",
                    ),
                    createdAt: CREATED_AT,
                    createdAtCursor: CREATED_AT.toISOString(),
                    userId: PRINCIPAL.userId,
                    action: AUDIT_ACTION.UPDATE,
                    resourceType,
                    resourceId: "resource_test",
                    changes: CHANGES,
                    metadata: operation ? { operation } : null,
                  },
                ],
              }),
            }),
          }),
        };
      }
      return {
        from: () => ({
          innerJoin: () => ({
            where: async () => [
              {
                id: PRINCIPAL.userId,
                name: "Test User",
                email: "test@example.test",
              },
            ],
          }),
        }),
      };
    },
  });
  return {
    memberRole: sessionMemberRole("owner"),
    query: {},
    recordAuditEvent: auditRecorderDouble(),
    request: new Request("https://example.test/v1/audit-logs"),
    route: "/v1/audit-logs",
    safeDb,
    session: { activeOrganizationId: PRINCIPAL.organizationId },
    set: { headers: {} },
    user: { id: PRINCIPAL.userId, email: "test@example.test" },
    featureAccessSnapshot:
      featureId === "time-billing" && enrolled
        ? enrolledTimeBillingSnapshot(PRINCIPAL)
        : createFeatureAccessSnapshot({
            ...PRINCIPAL,
            decisions: new Map(
              (featureId === "list-verification"
                ? ([LEGAL_LISTS_FEATURE_ID, featureId] as const)
                : ([featureId] as const)
              ).map(
                (id) =>
                  [
                    id,
                    enrolled || id === LEGAL_LISTS_FEATURE_ID
                      ? decideFeatureAccess({
                          ...PRINCIPAL,
                          registry: FEATURE_REGISTRY,
                          grants: Object.fromEntries(
                            [
                              ...featurePrerequisiteClosure(
                                FEATURE_REGISTRY,
                                id,
                              ),
                            ].map((grantFeatureId) => [
                              grantFeatureId,
                              [
                                {
                                  type: "organization" as const,
                                  organizationId: PRINCIPAL.organizationId,
                                },
                              ],
                            ]),
                          ),
                          featureId: id,
                          user: {
                            email: "test@example.test",
                            emailVerified: true,
                          },
                          membership: true,
                          enrolments: [{ ...PRINCIPAL, featureId: id }],
                        })
                      : { status: "hidden" },
                  ] as const,
              ),
            ),
          }),
  };
};

describe("audit details follow feature enrolment", () => {
  for (const resourceType of BILLING_RESOURCES) {
    for (const enrolled of [false, true]) {
      const changesStatus = enrolled ? "visible" : "feature_unavailable";

      test(`${resourceType} list details are ${changesStatus}`, async () => {
        const result = await readAuditLogs.handler(
          asTestRaw<Parameters<typeof readAuditLogs.handler>[0]>(
            contextFor({ resourceType, enrolled }),
          ),
        );
        expect(result).toMatchObject({
          items: [
            {
              userId: PRINCIPAL.userId,
              createdAt: CREATED_AT,
              action: AUDIT_ACTION.UPDATE,
              resourceType,
              resourceId: "resource_test",
              changes: enrolled ? CHANGES : null,
              changesStatus,
            },
          ],
          nextCursor: null,
        });
      });

      test(`${resourceType} export details are ${changesStatus}`, async () => {
        const result = await exportAuditLogs.handler(
          asTestRaw<Parameters<typeof exportAuditLogs.handler>[0]>(
            contextFor({ resourceType, enrolled }),
          ),
        );
        expect(result).toBe(
          `Time,User Name,User Email,Action,Resource Type,Resource ID,Changes,Changes Status\n` +
            `2026-07-16T12:00:00.000Z,Test User,test@example.test,update,${resourceType},resource_test,${
              enrolled ? '"{""amount"":{""old"":100,""new"":200}}"' : ""
            },${changesStatus}`,
        );
      });
    }
  }

  for (const enrolled of [false, true]) {
    test(`native MCP audit details follow enrolment ${enrolled}`, async () => {
      const fixture = contextFor({
        resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
        enrolled,
      });
      const result = await RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log({
        args: {},
        context: asTestRaw<McpRequestContext>({
          ...PRINCIPAL,
          memberRole: "owner",
          safeDb: fixture.safeDb,
          recordAuditEvent: fixture.recordAuditEvent,
          featureAccessSnapshot: fixture.featureAccessSnapshot,
        }),
      });
      if (isMcpEgressPlan(result)) {
        throw new TypeError("Audit reads return a tool result");
      }
      const serialized = serializeToolResult(result);
      expect(serialized.isError).not.toBe(true);
      expect(serialized.structuredContent).toMatchObject({
        items: [
          {
            resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
            changes: enrolled ? CHANGES : null,
            changesStatus: enrolled ? "visible" : "feature_unavailable",
          },
        ],
      });
    });
  }
});

describe("audit operation details follow verification enrolment", () => {
  for (const operation of [
    "fact_details_set",
    "source_verification_changed",
    "item_updated",
  ]) {
    for (const enrolled of [false, true]) {
      const visible = operation === "item_updated" || enrolled;
      const fixture = () =>
        contextFor({
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          operation,
          featureId: "list-verification",
          enrolled,
        });
      test(`${operation} list and export follow enrolment ${enrolled}`, async () => {
        const result = await readAuditLogs.handler(
          asTestRaw<Parameters<typeof readAuditLogs.handler>[0]>(fixture()),
        );
        expect(result).toMatchObject({
          items: [
            {
              resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
              action: AUDIT_ACTION.UPDATE,
              userId: PRINCIPAL.userId,
              changes: visible ? CHANGES : null,
              changesStatus: visible ? "visible" : "feature_unavailable",
            },
          ],
        });
        const csv = await exportAuditLogs.handler(
          asTestRaw<Parameters<typeof exportAuditLogs.handler>[0]>(fixture()),
        );
        if (typeof csv !== "string") {
          throw new TypeError("Expected the export to return CSV text");
        }
        expect(csv).toContain(",legal_list_item,resource_test,");
        expect(
          csv.endsWith(visible ? ",visible" : ",feature_unavailable"),
        ).toBe(true);
        expect(csv.includes('""amount""')).toBe(visible);
      });
      test(`${operation} generated MCP and CLI dispatch preserve status for enrolment ${enrolled}`, async () => {
        const context = fixture();
        const endpoint = await CAPABILITY_DISPATCH["audit-logs.list"].load();
        const result = await endpoint.default.handler(
          asTestRaw<Parameters<typeof endpoint.default.handler>[0]>(context),
        );
        const mapped = mapHandlerResult({
          id: "audit-logs.list",
          result,
          access: "read",
        });
        if (!isMcpEgressPlan(mapped) || mapped.egress !== "structured") {
          throw new TypeError("Audit capabilities return structured results");
        }
        expect(mapped.payload).toMatchObject({
          items: [
            {
              changes: visible ? CHANGES : null,
              changesStatus: visible ? "visible" : "feature_unavailable",
            },
          ],
        });
      });
    }
  }
});
