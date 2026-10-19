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

  test.each([
    [
      AI_FAILURE_CODES.output_moderated,
      messages.errors.apiCodes.aiOutputModerated,
    ],
    [AI_FAILURE_CODES.unknown, messages.errors.apiCodes.aiUnknown],
    [
      AI_FAILURE_CODES.provider_task_unsupported,
      messages.errors.apiCodes.aiProviderTaskUnsupported,
    ],
    [
      AI_FAILURE_CODES.model_unavailable,
      messages.chat.sendErrorModelUnavailable,
    ],
  ])("shows the specific message for %s", (code, message) => {
    const error = toAPIError({
      status: 502,
      value: { code, message: "Private provider detail" },
    });

    expect(error.message).toBe(message);
  });
});

describe("server errors outside AI", () => {
  test("a generic server error keeps the caller's fallback", () => {
    const error = toAPIError({
      status: 500,
      value: { code: "internal_server_error", message: "Server detail" },
    });

    expect(userErrorFromThrown(error, "Action failed")).toBe("Action failed");
  });
});
