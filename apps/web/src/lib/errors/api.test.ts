import { describe, expect, test } from "bun:test";

import { AI_FAILURE_CODES } from "@stll/api-contract";

import messages from "@/i18n/langs/en.json";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

import { isDisplayableAPIError, toAPIError } from "./api";

describe("AI API failures", () => {
  test.each(Object.values(AI_FAILURE_CODES))(
    "localizes and displays %s",
    (code) => {
      const error = toAPIError({
        status: 502,
        value: { code, message: "Private provider detail" },
      });

      expect(isDisplayableAPIError(error)).toBe(true);
      expect(userErrorFromThrown(error, "Generic fallback")).toBe(
        error.message,
      );
      expect(error.message).not.toBe("Generic fallback");
      expect(error.message).not.toBe("Private provider detail");
    },
  );

  test("shows a retry message for an incomplete model output", () => {
    const error = toAPIError({
      status: 502,
      value: {
        code: AI_FAILURE_CODES.output_incomplete,
        message: "Failed to improve search query",
      },
    });

    expect(isDisplayableAPIError(error)).toBe(true);
    expect(userErrorFromThrown(error, "Something went wrong")).toBe(
      messages.chat.sendErrorStreamIncomplete,
    );
  });
});
