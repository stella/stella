import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { TableChartDecisionCaller } from "@/api/handlers/chat/table-chart-plan";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createTableChart } from "./table-chart";

const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "table-chart-test-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

const table = {
  headers: ["Category", "Amount"],
  rows: [
    ["One", "12"],
    ["Two", "18"],
  ],
};

let ids: TestIds;
let testDb: TestDatabase;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  ids = fixture.ids;
  testDb = fixture.testDb;
});

afterAll(async () => {
  await releaseRlsFixture();
});

type TableChartCtx = Parameters<
  ReturnType<typeof createTableChart>["handler"]
>[0];

const noopAuditRecorder: AuditRecorder = async () => undefined;

const runTableChart = async (decide: TableChartDecisionCaller) =>
  await createTableChart({ decide }).handler(
    asTestRaw<TableChartCtx>({
      body: table,
      createAuditRecorder: () => noopAuditRecorder,
      getActiveWorkspaceIds: async () => [ids.wsA1],
      getAccessibleWorkspaces: async () => [],
      getWorkspaceAccess: async () => null,
      memberRole: sessionMemberRole("owner"),
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu" as const,
      promptCachingEnabled: false,
      recordAuditEvent: noopAuditRecorder,
      request: new Request("http://localhost/v1/chat/table-chart"),
      route: "/v1/chat/table-chart" satisfies ApiRoutePath,
      safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      set: { headers: {} },
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );

describe("table chart planning", () => {
  test("forwards the caller's AI configuration, usage context and table", async () => {
    const calls: Parameters<TableChartDecisionCaller>[0][] = [];
    const result = await runTableChart(async (options) => {
      calls.push(options);
      return await Promise.resolve({ decisions: {}, model: null });
    });

    expect(result).toEqual({ status: "unavailable" });
    expect(calls).toHaveLength(1);
    const options = calls.at(0);
    expect(options?.orgAIConfig).toEqual(orgAIConfig);
    expect(options?.usageMetering).toMatchObject({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceId: null,
      actionType: "chat",
      serviceTier: "standard",
    });
    expect(options?.id).toBe("chat.table-chart");
    expect(options?.state).toEqual(table);
  });
});
