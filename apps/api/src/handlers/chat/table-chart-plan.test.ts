import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  TABLE_CHART_LIMITS,
  tableChartRequestSchema,
} from "@stll/api-contract/table-chart";

import { planTableChart } from "@/api/handlers/chat/table-chart-plan";
import type { TableChartDecisionCaller } from "@/api/handlers/chat/table-chart-plan";
import type { Decision } from "@/api/lib/workflow/decisions/decide";
import {
  DEFAULT_SYSTEM_ONE_MODEL,
  serializeSystemOneRequest,
  SYSTEM_ONE_MAX_REQUEST_BYTES,
} from "@/api/lib/workflow/decisions/system-one";
import type { ChoiceAnswer } from "@/api/lib/workflow/decisions/system-one";
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
  state: "decided",
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

const plan = async (decide: TableChartDecisionCaller) =>
  await planTableChart({
    table,
    decide,
    decisionOptions: { orgAIConfig: null },
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
        decisionOptions: { orgAIConfig: null },
      }),
    ).toEqual({ status: "unavailable" });
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
      decisionOptions: { orgAIConfig: null, abortSignal: controller.signal },
      decide: async () => {
        controller.abort();
        return await Promise.reject(controller.signal.reason);
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
        const row = headers.map(() => cell.repeat(80));
        const candidate = { headers, rows: [...rows, row] };
        if (!v.safeParse(tableChartRequestSchema, candidate).success) {
          break;
        }
        rows.push(row);
      }
      const bounded = v.parse(tableChartRequestSchema, { headers, rows });
      await planTableChart({
        table: bounded,
        decisionOptions: { orgAIConfig: null },
        decide: async ({ state, questions }) => {
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
