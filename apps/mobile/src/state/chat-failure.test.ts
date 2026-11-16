import { expect, test } from "bun:test";

import { AI_ERROR_KINDS } from "@stll/api-contract/ai-errors";

import { CATALOGS } from "@/i18n/catalogs";
import { chatFailureStepsKey, storedTurnFailure } from "@/state/chat-failure";

// The phone cannot open stella desktop on the person's computer, so an
// agent to sign in or install says where in stella desktop that is.
test("an agent to sign in or install says where in stella desktop to fix it, and no other failure does", () => {
  const withSteps = AI_ERROR_KINDS.filter(
    (kind) => chatFailureStepsKey(kind) !== null,
  );
  expect(withSteps.toSorted()).toEqual([
    "local_runner_harness_unavailable",
    "local_runner_needs_login",
  ]);
  for (const kind of withSteps) {
    expect(chatFailureStepsKey(kind)).toBe("desktopSettingsSteps");
  }
});

test("a stored turn that failed for sign-in shows the way to stella desktop's settings", () => {
  const failure = storedTurnFailure({
    turnOutcome: { type: "failed", error: "local_runner_needs_login" },
  });
  expect(failure).toBe("local_runner_needs_login");
  const steps = failure === undefined ? null : chatFailureStepsKey(failure);
  expect(steps).toBe("desktopSettingsSteps");
  expect(steps === null ? null : CATALOGS.en.chat.localRun[steps]).toBe(
    "In stella desktop on your computer, open Settings › General › AI subscriptions.",
  );
});
