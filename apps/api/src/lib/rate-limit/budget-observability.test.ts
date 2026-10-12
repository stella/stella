import { describe, expect, test } from "bun:test";

import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { ACCOUNT_ATTEMPT_RATE_LIMITS } from "@/api/lib/rate-limit/budget-config";
import {
  BUDGET_NAMES,
  recordBudgetRejection,
  type BudgetKeyKind,
} from "@/api/lib/rate-limit/budget-observability";
import {
  createOtpAccountBudget,
  createAccountAttemptBudget,
} from "@/api/lib/rate-limit/otp-account-budget";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

describe("budget rejection observations", () => {
  test("OTP and password account refusals report the configured window without the attempted account", async () => {
    const logger = installRecordingLogger();
    const metrics: string[] = [];
    setMetricLineSinkForTesting((line) => {
      metrics.push(line);
    });
    const context = {
      increment: async () => ({
        count: 1_000_001,
        nextReset: new Date(Date.now() + 900_000),
        start: Date.now(),
      }),
      decrement: async () => undefined,
      complete: async () => undefined,
    };
    try {
      for (const [owner, email, name, windowMs] of [
        [
          createOtpAccountBudget(context, "demo@example.test"),
          "private@example.test",
          "auth.otp.account",
          ACCOUNT_ATTEMPT_RATE_LIMITS.otp.durationMs,
        ],
        [
          createOtpAccountBudget(context, "demo@example.test"),
          " Demo@Example.Test ",
          "auth.otp.demo_account",
          ACCOUNT_ATTEMPT_RATE_LIMITS.demoOtp.durationMs,
        ],
        [
          createAccountAttemptBudget(context, {
            counterPrefix: "password-account",
            budgetFor: () => ACCOUNT_ATTEMPT_RATE_LIMITS.password,
            nameFor: () => "auth.password.account",
          }),
          "private@example.test",
          "auth.password.account",
          ACCOUNT_ATTEMPT_RATE_LIMITS.password.durationMs,
        ],
      ] as const) {
        expect((await owner.reserve(email)).isErr()).toBe(true);
        expect(logger.records.at(-1)?.attributes).toEqual({
          budget: name,
          "budget.keyKind": "account",
          "budget.windowMs": windowMs,
          "http.status_code": 429,
        });
        expect(JSON.parse(metrics.at(-1) ?? "{}")).toMatchObject({
          budgetName: name,
          RateLimitRejected: 1,
        });
      }
      expect(logger.records).toHaveLength(3);
      expect(metrics).toHaveLength(3);
    } finally {
      logger.restore();
      resetMetricLineSinkForTesting();
    }
  });

  test("each bounded budget emits one structured rejection and one labelled counter without caller data", () => {
    const logger = installRecordingLogger();
    const metrics: string[] = [];
    setMetricLineSinkForTesting((line) => {
      metrics.push(line);
    });
    try {
      const kinds = [
        "user",
        "client",
        "account",
        "bearer",
        "address",
      ] as const satisfies readonly BudgetKeyKind[];
      for (const name of BUDGET_NAMES) {
        for (const keyKind of kinds) {
          const before = metrics.length;
          recordBudgetRejection({ name, keyKind, windowMs: 12_345 });
          expect(logger.records.at(-1)).toEqual({
            severityText: "WARN",
            message: "rate_limit.rejected",
            attributes: {
              budget: name,
              "budget.keyKind": keyKind,
              "budget.windowMs": 12_345,
              "http.status_code": 429,
            },
          });
          expect(metrics.length).toBe(before + 1);
          expect(JSON.parse(metrics.at(-1) ?? "{}")).toEqual({
            budgetName: name,
            RateLimitRejected: 1,
            _aws: {
              Timestamp: expect.any(Number),
              CloudWatchMetrics: [
                {
                  Namespace: "Stella/Api",
                  Dimensions: [["budgetName"]],
                  Metrics: [{ Name: "RateLimitRejected", Unit: "Count" }],
                },
              ],
            },
          });
        }
      }
      expect(logger.records.length).toBe(metrics.length);
    } finally {
      logger.restore();
      resetMetricLineSinkForTesting();
    }
  });
});
