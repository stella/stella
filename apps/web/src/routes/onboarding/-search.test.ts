import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { onboardingSearchSchema } from "@/routes/onboarding/-search";

const parse = (search: Record<string, unknown>) =>
  v.parse(onboardingSearchSchema, search);

const scriptSchemeUrl = ["java", "script:alert(1)"].join("");

describe("onboarding search params", () => {
  test("carries the page the visitor was headed to, query included", () => {
    expect(
      parse({ redirectTo: "/knowledge/templates?intent=use&slug=nda" }),
    ).toEqual({
      redirectTo: "/knowledge/templates?intent=use&slug=nda",
    });
  });

  test("an absent destination leaves the wizard's own landing page", () => {
    expect(parse({})).toEqual({});
    expect(parse({ redirectTo: "/" })).toEqual({ redirectTo: undefined });
  });

  test("a hostile destination is dropped", () => {
    for (const evil of [
      "//evil.com",
      "/\\evil.com",
      "/\t/evil.com",
      "https://evil.com",
      scriptSchemeUrl,
    ]) {
      expect(parse({ redirectTo: evil })).toEqual({ redirectTo: undefined });
    }
  });

  test("a destination back into sign-in or onboarding is dropped", () => {
    for (const loop of ["/auth", "/auth/organization", "/onboarding"]) {
      expect(parse({ redirectTo: loop })).toEqual({ redirectTo: undefined });
    }
  });

  test("keeps the dev preview flag", () => {
    expect(parse({ preview: true })).toEqual({ preview: true });
  });
});
