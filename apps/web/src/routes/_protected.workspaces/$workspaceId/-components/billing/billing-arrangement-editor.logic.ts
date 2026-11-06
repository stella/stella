import { Result } from "better-result";
import * as v from "valibot";

import {
  parseDecimalToken,
  parseIntegerToken,
} from "@stll/agent-input/numeric-token";
import {
  BILLING_CAP_MINUTES_MAX,
  BPS_PER_PERCENTAGE_POINT,
} from "@stll/api-contract/billing";
import { currencyCodeSchema } from "@stll/api-contract/currency-code";
import { tryToMinorUnits } from "@stll/money";

export const hourlyArrangementSchema = (invalidCap: string) =>
  v.pipe(
    v.strictObject({
      currency: currencyCodeSchema,
      capAmount: v.string(),
      capMinutes: v.string(),
      alertThreshold: v.string(),
    }),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const value = dataset.value;
      const capAmount = value.capAmount
        ? tryToMinorUnits({ amount: value.capAmount, currency: value.currency })
        : undefined;
      if (capAmount === null || (capAmount !== undefined && capAmount <= 0)) {
        addIssue({ message: invalidCap });
        return NEVER;
      }
      const minuteResult = value.capMinutes
        ? parseIntegerToken(value.capMinutes, {
            sign: "unsigned",
            min: 1,
            max: BILLING_CAP_MINUTES_MAX,
          })
        : undefined;
      if (minuteResult !== undefined && Result.isError(minuteResult)) {
        addIssue({ message: invalidCap });
        return NEVER;
      }
      const capMinutes = minuteResult?.value;
      if (capAmount === undefined && capMinutes === undefined) {
        return { currency: value.currency };
      }
      const thresholdResult = parseDecimalToken(value.alertThreshold, {
        sign: "unsigned",
        min: 0.01,
        max: BPS_PER_PERCENTAGE_POINT,
      });
      if (Result.isError(thresholdResult)) {
        addIssue({ message: invalidCap });
        return NEVER;
      }
      const alertThresholdBps = Math.round(
        thresholdResult.value * BPS_PER_PERCENTAGE_POINT,
      );
      if (capMinutes !== undefined) {
        return {
          currency: value.currency,
          capMinutes,
          alertThresholdBps,
          ...(capAmount !== undefined && { capAmount }),
        };
      }
      return { currency: value.currency, capAmount, alertThresholdBps };
    }),
  );
