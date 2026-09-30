import { describe, expect, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";

import messages from "@/i18n/langs/en.json";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";
import { APIError, shouldRetryAPIRequest, toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";

const expectedMessages = Object.values(messages.errors.actionAdmission).filter(
  (message) => message !== messages.errors.actionAdmission.contact,
);

describe("action refusal presentation", () => {
  test("every refusal preserves its typed outcome, localized message and retry disposition", () => {
    const observedMessages = [];
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      const response = {
        status: refusal.status,
        value: {
          code,
          message: "Internal details",
          contactUrl: "https://example.test/help",
        },
      };
      const error = toAPIError(response);
      const outcome = actionAdmissionOutcome(error);
      expect(outcome?.code).toBe(code);
      const hasContact =
        code === ACTION_ADMISSION_CODES.periodExhausted ||
        code === ACTION_ADMISSION_CODES.notEnabled;
      expect(outcome?.contactUrl).toBe(
        hasContact ? "https://example.test/help" : undefined,
      );
      expect(outcome?.retryable).toBe(refusal.retryable);
      expect(shouldRetryAPIRequest(0, error)).toBe(refusal.retryable);
      expect(shouldRetryAPIRequest(3, error)).toBe(false);
      expect(userErrorMessage(response, "Generic failure")).toBe(error.message);
      expect(userErrorFromThrown(error, "Generic failure")).toBe(error.message);
      observedMessages.push(error.message);
    }
    expect(observedMessages.toSorted()).toEqual(expectedMessages.toSorted());
  });

  test("recognizes a refusal retained in a transport wrapper cause", () => {
    const error = toAPIError({
      status: 403,
      value: { code: "action_not_enabled", message: "Refused" },
    });
    expect(
      actionAdmissionOutcome(new Error("Transport failed", { cause: error }))
        ?.code,
    ).toBe(error.code);
  });

  test.each([
    undefined,
    "",
    "/help",
    "mailto:help@example.test",
    ["java", "script:void(0)"].join(""),
  ])("omits an absent or unsupported contact target %s", (contactUrl) => {
    const error = new APIError({
      status: 403,
      code: "action_not_enabled",
      message: "Refused",
      details: { contactUrl },
    });
    expect(actionAdmissionOutcome(error)?.contactUrl).toBeUndefined();
  });

  test("unrelated failures remain outside the refusal treatment", () => {
    expect(
      actionAdmissionOutcome(
        new APIError({ status: 503, message: "Unavailable" }),
      ),
    ).toBeUndefined();
    expect(actionAdmissionOutcome(null)).toBeUndefined();
  });
});
