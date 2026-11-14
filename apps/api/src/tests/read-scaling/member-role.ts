import { panic } from "better-result";

import readMemberRole from "@/api/handlers/me/role/get";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { toSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The caller's role comes from the membership the request already resolved,
 * so a read costs no statements however much data the deployment holds.
 */
export const memberRoleScalingScenario = {
  name: "caller's role",
  definition: readMemberRole,
  measure: async () =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await readMemberRole.handler(
        asTestRaw<Parameters<typeof readMemberRole.handler>[0]>({
          request: new Request("https://example.test/v1/me/role"),
          route: "/v1/me/role" satisfies ApiRoutePath,
          session: {
            activeOrganizationId: toSafeId<"organization">("org_scaling"),
          },
          user: { id: toSafeId<"user">("user_scaling") },
          memberRole: sessionMemberRole("intern"),
        }),
      );
      if (response instanceof HttpStatusResponse || !("role" in response)) {
        return panic("Role scaling requires a successful handler response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
        role: response.role,
      };
    }),
};
