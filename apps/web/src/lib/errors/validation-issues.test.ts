import { describe, expect, test } from "bun:test";

import { apiFieldIssueMessage, toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

const rejected = (issues: unknown) =>
  toAPIError({
    status: 422,
    value: { message: "Invalid request", code: "validation", issues },
  });

describe("a rejected request's field issues", () => {
  test("a field over its length limit names the limit, not a generic failure", () => {
    const error = rejected([
      { field: "name", constraint: "maxLength", limit: 256 },
    ]);

    const shown = userErrorFromThrown(error, "Action failed");
    expect(shown).not.toBe("Action failed");
    expect(shown).toContain("256");
  });

  test("a missing required field gets its own message", () => {
    const shown = userErrorFromThrown(
      rejected([{ field: "name", constraint: "required" }]),
      "Action failed",
    );

    expect(shown).not.toBe("Action failed");
    expect(shown).not.toBe(
      userErrorFromThrown(
        rejected([{ field: "name", constraint: "invalid" }]),
        "Action failed",
      ),
    );
  });

  test("a validation answer without readable issues asks to check the request", () => {
    const generic = userErrorFromThrown(rejected([]), "Action failed");

    expect(generic).not.toBe("Action failed");
    expect(
      userErrorFromThrown(
        rejected([{ field: "name", constraint: "unknown-kind" }]),
        "Action failed",
      ),
    ).toBe(generic);
    expect(
      userErrorFromThrown(
        rejected([{ field: "name", constraint: "maxLength", limit: 256 }]),
        "Action failed",
      ),
    ).not.toBe(generic);
  });
});

describe("a field's own validation issue", () => {
  test("names the limit for the field the server rejected", () => {
    const error = rejected([
      { field: "layout", constraint: "invalid" },
      { field: "name", constraint: "maxLength", limit: 256 },
    ]);

    expect(apiFieldIssueMessage(error, "name")).toContain("256");
    expect(apiFieldIssueMessage(error, "title")).toBeUndefined();
  });

  test("is absent for errors that are not validation answers", () => {
    const conflict = toAPIError({
      status: 409,
      value: {
        message: "Conflict",
        code: "version_conflict",
        issues: [{ field: "name", constraint: "maxLength", limit: 256 }],
      },
    });

    expect(apiFieldIssueMessage(conflict, "name")).toBeUndefined();
    expect(apiFieldIssueMessage(new Error("boom"), "name")).toBeUndefined();
  });
});
