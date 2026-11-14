import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  TABLE_CHART_LIMITS,
  tableChartRequestSchema,
} from "@stll/api-contract/table-chart";

import { planTableChart } from "@/api/handlers/chat/table-chart-plan";
import type { TableChartDecisionCaller } from "@/api/handlers/chat/table-chart-plan";
import { toSafeId } from "@/api/lib/branded-types";
import type { Decision } from "@/api/lib/workflow/decisions/decide";
import {
  DEFAULT_SYSTEM_ONE_MODEL,
  serializeSystemOneRequest,
  SYSTEM_ONE_MAX_REQUEST_BYTES,
} from "@/api/lib/workflow/decisions/system-one";
import type { ChoiceAnswer } from "@/api/lib/workflow/decisions/system-one";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

let analytics: RecordingAnalytics | null = null;
afterEach(() => {
  analytics?.restore();
  analytics = null;
});

const table = {
  headers: ["Year", "Revenue"],
  rows: [
    ["2024", "12"],
    ["2025", "18"],
  ],
};
const confident = (selected: string): Decision<ChoiceAnswer> => ({
  source: "decision-model",
  model: null,
  state: "decided",
  evidence: null,
  probability: 0.99,
  confidence: 0.99,
  answer: {
    type: "choice",
    choice: selected,
    probabilities: { [selected]: 1 },
    confidence: 0.99,
  },
});
const decisions = () => ({
  kind: confident("bar"),
  sort: confident("none"),
  title: confident("column_1"),
  column_0: confident("label"),
  column_1: confident("y"),
});
const askWith =
  (answers: Record<string, Decision<ChoiceAnswer>>): TableChartDecisionCaller =>
  async () =>
    await Promise.resolve({ decisions: answers, model: "test" });

const organizationId = toSafeId<"organization">("org-table-chart");
const generation = {
  task: "short-text",
  dataClass: "customer",
  userId: null,
  orgAIConfig: null,
  managedAIResidency: "eu",
  organizationId,
  admission: testModelAdmission(organizationId, "chat.table-chart"),
  tenantWorkspaceIds: [],
  serviceTier: "standard",
  caching: { enabled: false, reason: "org-disabled" },
  prompt: "Decide the chart of the supplied table.",
} as const;

const plan = async (decide: TableChartDecisionCaller) =>
  await planTableChart({
    table,
    decide,
    decisionOptions: { orgAIConfig: null, generation },
  });

describe("table chart decisions", () => {
  test("maps one confident batch to a validated chart without another call", async () => {
    let calls = 0;
    const result = await plan(async (options) => {
      calls += 1;
      expect(options.dataClass).toBe("customer");
      expect(options.state).toEqual(table);
      expect(Object.keys(options.questions).toSorted()).toEqual([
        "column_0",
        "column_1",
        "kind",
        "sort",
        "title",
      ]);
      return await askWith(decisions())(options);
    });
    expect(calls).toBe(1);
    expect(result).toEqual({
      status: "ready",
      plan: {
        kind: "bar",
        sort: "none",
        title: "Revenue",
        columns: [
          { index: 0, role: "label" },
          { index: 1, role: "y" },
        ],
      },
    });
  });

  test("abstaining and unavailable answers preserve the table", async () => {
    for (const reason of ["below-floor", "no-backend", "failed"] as const) {
      for (const key of Object.keys(decisions())) {
        const unavailable = {
          source: "decision-model",
          model: null,
          state: "undecided",
          reason,
          confidence: null,
        } as const satisfies Decision<ChoiceAnswer>;
        const answers = Object.fromEntries(
          Object.entries(decisions()).map(
            ([id, decision]) =>
              [id, id === key ? unavailable : decision] as const,
          ),
        );
        expect(await plan(askWith(answers))).toEqual({ status: "unavailable" });
      }
    }
    expect(
      await plan(askWith({ ...decisions(), kind: confident("none") })),
    ).toEqual({ status: "unavailable" });
    expect(
      await plan(askWith({ ...decisions(), column_1: confident("none") })),
    ).toEqual({ status: "unavailable" });
  });

  test("invalid choices and nonnumeric values cannot become a chart", async () => {
    expect(
      await plan(askWith({ ...decisions(), kind: confident("radar") })),
    ).toEqual({ status: "unavailable" });
    expect(
      await plan(askWith({ ...decisions(), column_1: confident("x") })),
    ).toEqual({ status: "unavailable" });
    expect(
      await planTableChart({
        table: { ...table, rows: [["2024", "1,234"]] },
        decide: askWith(decisions()),
        decisionOptions: { orgAIConfig: null, generation },
      }),
    ).toEqual({ status: "unavailable" });
  });

  test("a table without a numeric column spends no decision", async () => {
    let calls = 0;
    const result = await planTableChart({
      table: {
        headers: ["Situace", "Následek"],
        rows: [
          ["Opilost při řízení", "Okamžité zrušení"],
          ["Nízká hladina", "Výpověď"],
        ],
      },
      decisionOptions: { orgAIConfig: null, generation },
      decide: async () => {
        calls += 1;
        return await Promise.resolve({ decisions: {}, model: null });
      },
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(calls).toBe(0);
  });

  test("unexpected decision failures return an unavailable chart and emit no table contents", async () => {
    analytics = installRecordingAnalytics();
    const result = await plan(
      async () => await Promise.reject(new Error("Synthetic decision failure")),
    );
    expect(result).toEqual({ status: "unavailable" });
    expect(analytics.exceptions()).toHaveLength(1);
    expect(JSON.stringify(analytics.events)).not.toContain("Revenue");
  });

  test("cancelled planning preserves the table without error telemetry", async () => {
    analytics = installRecordingAnalytics();
    const controller = new AbortController();
    const result = await planTableChart({
      table,
      decisionOptions: {
        orgAIConfig: null,
        generation,
        abortSignal: controller.signal,
      },
      decide: async () => {
        controller.abort();
        return await Promise.reject(
          new Error("Synthetic planning cancellation"),
        );
      },
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(analytics.exceptions()).toHaveLength(0);
  });

  test("bounded multilingual and escaped tables fit the decision envelope", async () => {
    for (const cell of ["漢", "😀", "\u0000", "\\", '"']) {
      const headers = Array.from({ length: TABLE_CHART_LIMITS.columns }, () =>
        cell.repeat(
          Math.floor(TABLE_CHART_LIMITS.headerCharacters / cell.length),
        ),
      );
      const rows: string[][] = [];
      for (let count = 0; count < TABLE_CHART_LIMITS.rows; count += 1) {
        // One numeric column keeps the table chartable, so the decision runs.
        const row = headers.map((_header, index) =>
          index === 0 ? "1" : cell.repeat(80),
        );
        const candidate = { headers, rows: [...rows, row] };
        if (!v.safeParse(tableChartRequestSchema, candidate).success) {
          break;
        }
        rows.push(row);
      }
      const bounded = v.parse(tableChartRequestSchema, { headers, rows });
      let decided = false;
      await planTableChart({
        table: bounded,
        decisionOptions: { orgAIConfig: null, generation },
        decide: async ({ state, questions }) => {
          decided = true;
          const body = serializeSystemOneRequest({
            state,
            questions,
            model: DEFAULT_SYSTEM_ONE_MODEL,
          });
          expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
            SYSTEM_ONE_MAX_REQUEST_BYTES,
          );
          return { decisions: {}, model: null };
        },
      });
      expect(decided).toBe(true);
    }
  });

  test("none title is a valid empty descriptive title", async () => {
    const result = await plan(
      askWith({ ...decisions(), title: confident("none") }),
    );
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.plan.title).toBe("");
    }
  });
});
