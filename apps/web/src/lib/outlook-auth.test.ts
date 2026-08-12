import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  buildOutlookHandoffPath,
  buildOutlookOrganizationSelectionUrl,
  buildOutlookSignInPath,
  outlookSessionHandoff,
  resolveOutlookSessionLookup,
  surfaceOutlookHandoffFailure,
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

  test("propagates a resolved session lookup error before classifying the user as signed out", () => {
    const lookupError = { status: 503 };
    const mappedError = new Error("Session lookup failed");

    expect(() =>
      resolveOutlookSessionLookup({
        mapError: (error) => {
          expect(error).toBe(lookupError);
          return mappedError;
        },
        result: { data: null, error: lookupError },
      }),
    ).toThrow(mappedError);
  });

  test("encodes the dialog origin in a safe relative handoff", () => {
    expect(buildOutlookHandoffPath("https://outlook.example.test")).toBe(
      "/sign-in-outlook?parentOrigin=https%3A%2F%2Foutlook.example.test",
    );
  });

  test("routes signed-out users through the configured stella sign-in methods", () => {
    expect(buildOutlookSignInPath("https://outlook.example.test")).toBe(
      "/auth?redirectTo=%2Fsign-in-outlook%3FparentOrigin%3Dhttps%253A%252F%252Foutlook.example.test",
    );
  });

  test("surfaces initialization failures before propagating them to telemetry", async () => {
    const error = new Error("Office initialization failed");
    let surfaced = false;

    const result = await Result.tryPromise({
      try: async () =>
        await surfaceOutlookHandoffFailure(Promise.reject(error), () => {
          surfaced = true;
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBe(error);
    }
    expect(surfaced).toBe(true);
  });
});
