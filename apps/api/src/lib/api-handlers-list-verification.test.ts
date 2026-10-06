import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import factDetails from "@/api/handlers/lists/items/fact-details/update";
import sourceReview from "@/api/handlers/lists/items/sources/verification/update";
import bulkReview from "@/api/handlers/lists/verifications/claim-reviews/bulk/create";
import review from "@/api/handlers/lists/verifications/claim-reviews/create";
import create from "@/api/handlers/lists/verifications/create";
import get from "@/api/handlers/lists/verifications/get";
import latest from "@/api/handlers/lists/verifications/latest/list";
import list from "@/api/handlers/lists/verifications/list";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const context = (tx: unknown) => ({
  ...createScopedDbMock(tx),
  user: { id: toSafeId<"user">("user_a"), email: "member@example.test" },
  session: { activeOrganizationId: toSafeId<"organization">("org_a") },
  workspaceId: toSafeId<"workspace">("workspace_a"),
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  request: new Request("https://example.test/lists"),
  set: { headers: {} },
});

const endpoints = {
  create,
  list,
  get,
  latest,
  review,
  bulkReview,
  factDetails,
  sourceReview,
};

describe("verification handler access admission", () => {
  test("every dedicated handler denies empty grants before resource operations", async () => {
    const previous = env.API_FEATURE_ACCESS_GRANTS;
    env.API_FEATURE_ACCESS_GRANTS = {};
    try {
      for (const endpoint of Object.values(endpoints)) {
        expect(endpoint.config.featureAccess).toEqual({
          featureId: "list-verification",
          type: "required",
        });
        for (const runId of ["lvr_existing", "lvr_missing"]) {
          let operations = 0;
          let identityQueries = 0;
          const tx = {
            select: () => {
              identityQueries += 1;
              return {
                from: () => ({
                  innerJoin: () => ({
                    where: () => ({
                      limit: async () => [
                        { email: "member@example.test", emailVerified: true },
                      ],
                    }),
                  }),
                }),
              };
            },
            insert: () => {
              operations += 1;
              throw new Error("Resource operation must not run");
            },
          };
          const result = await endpoint.handler(
            asTestRaw({ ...context(tx), params: { runId }, body: {} }),
          );
          expect(result).toMatchObject({
            code: 404,
            response: { message: "Not found" },
          });
          expect(operations).toBe(0);
          expect(identityQueries).toBe(1);
        }
      }
    } finally {
      env.API_FEATURE_ACCESS_GRANTS = previous;
    }
  });

  test("a current verified member receives a proof for direct handler execution", async () => {
    const previous = env.API_FEATURE_ACCESS_GRANTS;
    const previousDeployment = env.FEATURE_LEGAL_LISTS;
    env.FEATURE_LEGAL_LISTS = true;
    env.API_FEATURE_ACCESS_GRANTS = {
      "list-verification": [
        {
          type: "member",
          organizationId: "org_a",
          email: "member@example.test",
        },
      ],
    };
    try {
      const config = {
        featureAccess: { featureId: "list-verification", type: "required" },
        permissions: { workspace: ["read"] },
        access: "read",
        accountAccess: "sandbox",
        mcp: { type: "internal", reason: "ui_navigation_state" },
      } satisfies HandlerConfig;
      let executions = 0;
      const endpoint = createSafeRootHandler(
        config,
        async function* ({ featureAccessProof }) {
          executions += 1;
          return Result.ok({ proof: featureAccessProof });
        },
      );
      const query = {
        leftJoin: () => query,
        where: () => query,
        limit: async () => [
          { email: "member@example.test", emailVerified: true },
        ],
      };
      const tx = {
        select: () => ({ from: () => ({ innerJoin: () => query }) }),
      };
      const result = await endpoint.handler(asTestRaw(context(tx)));
      expect(result).toMatchObject({
        proof: {
          featureId: "list-verification",
          organizationId: "org_a",
          userId: "user_a",
        },
      });
      expect(executions).toBe(1);
    } finally {
      env.API_FEATURE_ACCESS_GRANTS = previous;
      env.FEATURE_LEGAL_LISTS = previousDeployment;
    }
  });
});
