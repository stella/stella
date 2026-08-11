import { describe, expect, test } from "bun:test";

import {
  buildOutlookHandoffPath,
  buildOutlookOrganizationSelectionUrl,
  outlookSessionHandoff,
} from "@/lib/outlook-auth";

describe("Outlook authentication handoff", () => {
  test("routes social sign-in through organization selection", () => {
    const callback = new URL(
      buildOutlookOrganizationSelectionUrl({
        frontendOrigin: "https://my.example.test",
        parentOrigin: "https://outlook.example.test",
      }),
    );

    expect(callback.origin).toBe("https://my.example.test");
    expect(callback.pathname).toBe("/auth/organization");
    expect(callback.searchParams.get("redirectTo")).toBe(
      "/sign-in-outlook?parentOrigin=https%3A%2F%2Foutlook.example.test",
    );
  });

  test("requires organization selection before delivering an existing session", () => {
    expect(outlookSessionHandoff(null)).toBe("signed-out");
    expect(outlookSessionHandoff({ token: "token" })).toBe(
      "select-organization",
    );
    expect(
      outlookSessionHandoff({
        activeOrganizationId: "organization-id",
        token: "token",
      }),
    ).toBe("deliver");
  });

  test("encodes the dialog origin in a safe relative handoff", () => {
    expect(buildOutlookHandoffPath("https://outlook.example.test")).toBe(
      "/sign-in-outlook?parentOrigin=https%3A%2F%2Foutlook.example.test",
    );
  });
});
