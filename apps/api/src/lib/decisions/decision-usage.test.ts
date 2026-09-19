import { describe, expect, test } from "bun:test";

import type { usageEvents } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { decideMany } from "@/api/lib/decisions/decide";
import type { DecisionModel } from "@/api/lib/decisions/decision-model";
import { createSystemOneClient, noul } from "@/api/lib/decisions/system-one";
import { decisionUsageUnitsFromTokens } from "@/api/lib/usage/unit-model";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const setup = (keySource: DecisionModel["keySource"]) => {
  const rows: (typeof usageEvents.$inferInsert)[] = [];
  const { safeDb } = createScopedDbMock({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: () => ({
      values: (row: typeof usageEvents.$inferInsert) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (
              rows.some(
                (existing) => existing.idempotencyKey === row.idempotencyKey,
              )
            ) {
              return [];
            }
            rows.push(row);
            return [{ id: "event" }];
          },
        }),
      }),
    }),
  });
  let calls = 0;
  const client = {
    ...createSystemOneClient({
      apiKey: "test",
      fetcher: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            model: "jev-test",
            answers: { eligible: { type: "noul", noul: 0.99 } },
            usage: { input_tokens: 1_000_000, output_tokens: 400 },
          }),
        );
      },
    }),
    keySource,
  };
  const usageMetering = {
    actionType: "chat",
    organizationId: toSafeId<"organization">("org_decision"),
    safeDb,
    serviceTier: "standard",
    userId: toSafeId<"user">("user_decision"),
    workspaceId: null,
    callId: "decision-call-1",
  } as const;
  return { client, rows, usageMetering, calls: () => calls };
};

const questions = { eligible: noul("Is the applicant eligible?") };

describe("decision usage accounting", () => {
  test.each(["byok", "instance"] as const)(
    "records %s usage at the decision rate",
    async (keySource) => {
      const { client, rows, usageMetering } = setup(keySource);
      const result = await decideMany({
        id: "test.usage",
        orgAIConfig: null,
        state: "eligible",
        questions,
        client,
        usageMetering,
      });
      expect(result.decisions.eligible.state).toBe("decided");
      expect(rows).toHaveLength(1);
      expect(rows.at(0)).toMatchObject({
        organizationId: usageMetering.organizationId,
        userId: usageMetering.userId,
        modelRole: "decision",
        idempotencyKey: "decision:decision-call-1",
        rawUsageMicroUnits: 4200,
        unitsConsumed: keySource === "byok" ? 0 : 63,
        isByok: keySource === "byok",
      });
    },
  );

  test("keeps the normal action floor for tiny platform calls", () => {
    expect(
      decisionUsageUnitsFromTokens({
        inputTokens: 1,
        actionType: "case_law",
        isByok: false,
      }),
    ).toEqual({ rawUsageMicroUnits: 1, unitsConsumed: 12 });
    expect(
      decisionUsageUnitsFromTokens({
        inputTokens: 1,
        actionType: "case_law",
        isByok: true,
      }),
    ).toEqual({ rawUsageMicroUnits: 1, unitsConsumed: 0 });
  });

  test("does not spend instance funds behind a generative BYOK preflight", async () => {
    const { client, rows, usageMetering, calls } = setup("instance");
    const result = await decideMany({
      id: "test.byok-preflight",
      orgAIConfig: {
        providers: [{ provider: "openai", apiKey: "org-key" }],
        overrideModels: {
          chat: { provider: "openai", modelId: "gpt-5" },
          fast: { provider: "openai", modelId: "gpt-5-mini" },
          reasoning: { provider: "openai", modelId: "gpt-5" },
          pdf: { provider: "openai", modelId: "gpt-5-mini" },
        },
        decision: null,
      },
      state: "eligible",
      questions,
      client,
      usageMetering,
    });
    expect(result.decisions.eligible).toMatchObject({
      state: "undecided",
      reason: "no-backend",
    });
    expect(calls()).toBe(0);
    expect(rows).toEqual([]);
  });

  test("captures ledger failure while preserving the successful answer", async () => {
    const recording = installRecordingAnalytics();
    try {
      const { client, usageMetering } = setup("byok");
      const { safeDb } = createScopedDbMock({
        select: () => {
          throw new Error("ledger unavailable");
        },
      });
      const result = await decideMany({
        id: "test.ledger-failure",
        orgAIConfig: null,
        state: "eligible",
        questions,
        client,
        usageMetering: { ...usageMetering, safeDb },
      });
      expect(result.decisions.eligible.state).toBe("decided");
      expect(recording.exceptions()).toHaveLength(1);
    } finally {
      recording.restore();
    }
  });
});
