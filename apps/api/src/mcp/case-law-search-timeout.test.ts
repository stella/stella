import { SQL } from "bun";
import { expect, test } from "bun:test";

import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { PUBLIC_READ_TIMEOUT_CODE } from "@/api/lib/legal-search/public-read-timeout";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const state = createTestState({ file: import.meta.path, config: env });

for (const failure of ["thrown", "returned", "provision lookup"] as const) {
  test(`search_case_law returns actionable retryable errors for ${failure} statement timeouts`, async () => {
    state.setConfig("FEATURE_PUBLIC_LAW", true);
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        organizationSettings: {
          findFirst: async () => undefined,
        },
      },
    });
    let searched = false;
    let provisionLookupReached = false;
    const context = authorizedMcpContextForTest({
      accessibleWorkspaceIds: [],
      accessibleWorkspaceIdSet: new Set(),
      accessibleWorkspaceStatusById: new Map(),
      accessibleWorkspaces: [],
      grantedScopes: [],
      memberRole: "owner",
      organizationId: toSafeId<"organization">("org_1"),
      recordAuditEvent: asTestRaw(async () => undefined),
      safeDb,
      scopedDb,
      thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
      testDependencies: {
        readCaseLawCourtNames: async () => [],
        readProvisionWorkLinked: async () => {
          provisionLookupReached = true;
          throw new SQL.PostgresError("private provision SQL diagnostics", {
            code: "ERR_POSTGRES_SERVER_ERROR",
            errno: "57014",
            detail: "",
            hint: "",
            severity: "ERROR",
          });
        },
        searchDecisionsHandler: asTestRaw(async () => {
          searched = true;
          if (failure === "thrown") {
            throw new SQL.PostgresError("private SQL diagnostics", {
              code: "ERR_POSTGRES_SERVER_ERROR",
              errno: "57014",
              detail: "",
              hint: "",
              severity: "ERROR",
            });
          }
          return new HttpStatusResponse(503, {
            code: PUBLIC_READ_TIMEOUT_CODE,
            message: "Public read timed out. Please try again.",
          });
        }),
      },
      userId: toSafeId<"user">("user_1"),
      userEmail: "standard@example.test",
    });
    const result = await handleMcpToolCall({
      args:
        failure === "provision lookup"
          ? { country: "CZE", provision: "§ 2910 OZ" }
          : { country: "CZE", queries: ["smlouva"] },
      context,
      mode: "default",
      toolName: "search_case_law",
    });
    expect(searched).toBe(failure !== "provision lookup");
    expect(provisionLookupReached).toBe(failure === "provision lookup");
    expect(result.isError).toBe(true);
    const content = result.content.at(0);
    if (content?.type !== "text") {
      throw new Error("Expected a text MCP error envelope");
    }
    expect(JSON.parse(content.text)).toEqual({
      error: {
        code: "upstream_unavailable",
        message: "Case-law search exceeded its time budget.",
        hint: "Retry search_case_law with fewer queries or a narrower court, date range or provision filter. If it still times out, retry shortly.",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("SQL diagnostics");
  });
}
