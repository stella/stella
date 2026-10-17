import { describe, expect, test } from "bun:test";

import { commandErrorMessage } from "../src/mainview/command-error";

describe("command error message", () => {
  test("shows the reason a native command rejected with", () => {
    expect(commandErrorMessage("Could not open desktop connection", "x")).toBe(
      "Could not open desktop connection",
    );
    expect(commandErrorMessage(new Error("boom"), "x")).toBe("boom");
  });

  test("falls back only when there is no reason to show", () => {
    for (const error of [undefined, null, "", "  ", 42, {}, new Error("   ")]) {
      expect(commandErrorMessage(error, "fallback")).toBe("fallback");
    }
  });
});
