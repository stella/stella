import { describe, expect, test } from "bun:test";
import { t } from "elysia";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import {
  admitTaskFlowAccess,
  FLOW_TASK_FEATURE_ACCESS,
} from "@/api/lib/flows/review-gate-task";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();

describe("linked task flow admission", () => {
  for (const linked of [false, true]) {
    for (const deploymentEnabled of [false, true]) {
      for (const enrolled of [false, true]) {
        for (const access of ["read", "write"] as const) {
          test(`access=${access} linked=${String(linked)} deployment=${String(deploymentEnabled)} enrolled=${String(enrolled)}`, async () => {
            const restoreMode = setRuntimeModeForTesting({
              mode: RUNTIME_MODE.strict,
            });
            const previous = env.FEATURE_FLOWS;
            env.FEATURE_FLOWS = deploymentEnabled;
            try {
              const database = createScopedDbMock(
                {},
                {
                  flowTaskGates: linked
                    ? [
                        {
                          runId: createSafeId<"flowRun">(),
                          status: "awaiting_review",
                          organizationId,
                        },
                      ]
                    : [],
                  featureAccess: {
                    identity: {
                      email: "reader@example.test",
                      emailVerified: true,
                    },
                    enrolments: enrolled
                      ? [{ featureId: "flows", organizationId, userId }]
                      : [],
                  },
                },
              );
              const result = await database.safeDb(
                async (tx) =>
                  await admitTaskFlowAccess(tx, {
                    access,
                    workspaceId: createSafeId<"workspace">(),
                    taskEntityId: createSafeId<"entity">(),
                    userId,
                  }),
              );
              expect(result.isOk()).toBe(true);
              if (result.isErr()) {
                throw result.error;
              }
              expect(result.value.isOk()).toBe(
                !linked || (deploymentEnabled && enrolled),
              );
              if (result.value.isErr()) {
                expect(result.value.error).toMatchObject({
                  status: 404,
                  message: "Not found",
                });
              }
            } finally {
              env.FEATURE_FLOWS = previous;
              restoreMode();
            }
          });
        }
      }
    }
  }
  test("linked-resource access retains ordinary task input schemas", () => {
    const schemas = {
      body: t.Object({ taskId: t.String(), status: t.Optional(t.String()) }),
      params: undefined,
      query: undefined,
    };
    expect(FLOW_TASK_FEATURE_ACCESS.projectInputSchema(schemas)).toEqual(
      schemas,
    );
  });
});
