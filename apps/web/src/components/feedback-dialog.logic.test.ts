import { describe, expect, test } from "bun:test";

import { buildFeedbackMailto } from "@/components/feedback-dialog.logic";

describe("feedback email destination", () => {
  test("stays disabled unless a deployment configures a recipient", () => {
    expect(
      buildFeedbackMailto({
        recipient: undefined,
        route: "/workspaces/private-matter",
        userEmail: "lawyer@example.test",
      }),
    ).toBeNull();
  });

  test("includes the current route only for the configured recipient", () => {
    const href = buildFeedbackMailto({
      recipient: "ops@example.test",
      route: "/workspaces/current-matter",
      userEmail: "lawyer@example.test",
    });

    expect(href).toStartWith("mailto:ops@example.test?");
    expect(decodeURIComponent(href ?? "")).toContain(
      "Route: /workspaces/current-matter",
    );
  });
});
