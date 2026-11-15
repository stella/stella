import { SQL } from "bun";
import { expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { PUBLIC_READ_TIMEOUT_CODE } from "@/api/lib/legal-search/public-read-timeout";
import {
  flushFailureObservations,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import { createCaseLawContinuation } from "@/api/mcp/stella-tools";
import {
  caseLawSearchTimeoutResult,
  searchRefusalResult,
} from "@/api/mcp/tool-utils";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { createFakeContinuationStore } from "@/api/tests/helpers/fake-continuation-store";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const state = createTestState({ file: import.meta.path, config: env });

for (const failure of ["thrown", "returned", "provision lookup"] as const) {
  test(`search_case_law continues rather than failing on ${failure} statement timeouts`, async () => {
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
        caseLawSearchContinuation: createCaseLawContinuation({
          store: createFakeContinuationStore().store,
        }),
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
    expect(result.isError).not.toBe(true);
    const content = result.content.at(0);
    if (content?.type !== "text") {
      throw new Error("Expected a text MCP result");
    }
    expect(JSON.parse(content.text)).toMatchObject({ status: "running" });
    expect(JSON.stringify(result)).not.toContain("SQL diagnostics");
  });
}

test.each([
  {
    shape: "a returned timeout body",
    failure: new HttpStatusResponse(503, {
      code: PUBLIC_READ_TIMEOUT_CODE,
      message: "Public read timed out. Please try again.",
    }),
  },
  {
    shape: "a cancelled statement",
    failure: new SQL.PostgresError("private SQL diagnostics", {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "57014",
      detail: "",
      hint: "",
      severity: "ERROR",
    }),
  },
])("$shape grades as a public read timeout", ({ failure }) => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  resetFailureObservationsForTesting();
  try {
    expect(caseLawSearchTimeoutResult(failure)).not.toBeNull();
    expect(analytics.exceptions()).toEqual([]);
    flushFailureObservations();
    expect(
      logs.records.filter(({ message }) => message === "failure.observed"),
    ).toMatchObject([
      {
        attributes: {
          "failure.grade": "transient",
          "failure.reason": "public_read_timeout",
        },
      },
    ]);
  } finally {
    resetFailureObservationsForTesting();
    logs.restore();
    analytics.restore();
  }
});

test.each([
  { path: "the case-law time budget", read: caseLawSearchTimeoutResult },
  { path: "a public read", read: searchRefusalResult },
])("$path advises one identical repeat before narrowing", ({ read }) => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  resetFailureObservationsForTesting();
  try {
    const result = read(
      new HttpStatusResponse(503, {
        code: PUBLIC_READ_TIMEOUT_CODE,
        message: "Public read timed out. Please try again.",
      }),
    );
    if (result?.error.type !== "structured") {
      throw new Error("Expected a structured error");
    }
    expect(result.error.retryable).toBe(true);
    const hint = result.error.hint ?? "";
    const timesOutAgain = hint.indexOf("If it times out again");
    expect(hint.indexOf("Repeat the identical")).toBe(0);
    expect(timesOutAgain).toBeGreaterThan(0);
    expect(hint.slice(0, timesOutAgain)).not.toMatch(/narrow|fewer/iu);
    expect(hint.slice(timesOutAgain)).toMatch(/narrow/iu);
    expect(hint).not.toMatch(/succeed|will work/iu);
  } finally {
    resetFailureObservationsForTesting();
    logs.restore();
    analytics.restore();
  }
});
