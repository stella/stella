import { describe, expect, test } from "bun:test";

import {
  buildOutlookHandoffPath,
  buildOutlookSocialCallbackUrl,
} from "@/lib/outlook-auth";

describe("Outlook authentication handoff", () => {
  test("routes social sign-in through organization selection", () => {
    const callback = new URL(
      buildOutlookSocialCallbackUrl({
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

  test("encodes the dialog origin in a safe relative handoff", () => {
    expect(buildOutlookHandoffPath("https://outlook.example.test")).toBe(
      "/sign-in-outlook?parentOrigin=https%3A%2F%2Foutlook.example.test",
    );
  });
});
