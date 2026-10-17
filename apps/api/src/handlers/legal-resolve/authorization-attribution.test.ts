import { Result } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { authorizeLegalResolveRequest } from "@/api/handlers/legal-resolve/authorization";
import { resetCaptureWindows } from "@/api/lib/analytics/capture";
import {
  resetAnalyticsForTesting,
  setAnalyticsForTesting,
} from "@/api/lib/analytics/client";
import type { ServerAnalyticsCaptureParams } from "@/api/lib/analytics/server-analytics";
import {
  enrichRequestContext,
  initRequestContext,
} from "@/api/lib/observability/request-context";
import { McpTokenVerificationError } from "@/api/mcp/errors";

const captured: ServerAnalyticsCaptureParams[] = [];

beforeEach(() => {
  captured.length = 0;
  resetCaptureWindows();
  setAnalyticsForTesting({
    capture: (event) => {
      captured.push(event);
    },
    flush: async () => undefined,
    identifyOrganizationGroup: () => undefined,
  });
});

afterEach(() => {
  resetCaptureWindows();
  resetAnalyticsForTesting();
});

test.each(["token-verification", "session-resolution"] as const)(
  "legal resolve retains request attribution for %s failures",
  async (failurePath) => {
    const request = new Request("https://api.test/law/CZE/citations/resolve", {
      headers: { authorization: "Bearer synthetic-token" },
    });
    const attribution = {
      organizationId: "organization-attribution",
      posthogDistinctId: "distinct-attribution",
      sessionId: "session-attribution",
    };
    initRequestContext(request);
    enrichRequestContext(request, attribution);
    let authenticationCalls = 0;
    let sessionResolutionCalls = 0;

    const result = await authorizeLegalResolveRequest(request, {
      authenticate: async () => {
        authenticationCalls += 1;
        return failurePath === "token-verification"
          ? Result.err(
              new McpTokenVerificationError({
                message: "Verification unavailable",
              }),
            )
          : Result.ok({
              userId: "user-attribution",
              organizationId: attribution.organizationId,
              scopes: ["stella:law_read"],
            });
      },
      resolveSessionContext: async () => {
        sessionResolutionCalls += 1;
        throw new TypeError("Session resolution unavailable");
      },
      publicLawEnabled: () => true,
    });

    expect(result.status).toBe(503);
    expect(authenticationCalls).toBe(1);
    expect(sessionResolutionCalls).toBe(
      failurePath === "session-resolution" ? 1 : 0,
    );
    expect(captured).toHaveLength(1);
    expect(captured.at(0)).toMatchObject({
      event: "$exception",
      distinctId: attribution.posthogDistinctId,
      groups: { organization: attribution.organizationId },
      properties: {
        organization_id: attribution.organizationId,
        session_id: attribution.sessionId,
        phase:
          failurePath === "token-verification"
            ? "authentication"
            : "session-resolution",
      },
    });
  },
);
