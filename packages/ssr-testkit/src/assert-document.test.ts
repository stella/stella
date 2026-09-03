import { describe, expect, test } from "bun:test";

import {
  assertSsrDocument,
  SsrDocumentAssertionError,
} from "./assert-document";

describe("SSR document contract", () => {
  test("accepts complete HTML with required public content", () => {
    expect(() =>
      assertSsrDocument({
        contentType: "text/html; charset=utf-8",
        forbiddenContent: ["private account"],
        html: "<!doctype html><main>Catalogue</main>",
        requiredContent: ["<!doctype html>", "<main", "Catalogue"],
        status: 200,
      }),
    ).not.toThrow();
  });

  test.each([
    {
      code: "unexpected-status",
      input: {
        contentType: "text/html",
        html: "<main>Catalogue</main>",
        requiredContent: ["Catalogue"],
        status: 503,
      },
    },
    {
      code: "invalid-content-type",
      input: {
        contentType: "application/json",
        html: "<main>Catalogue</main>",
        requiredContent: ["Catalogue"],
        status: 200,
      },
    },
    {
      code: "missing-content",
      input: {
        contentType: "text/html",
        html: "<main></main>",
        requiredContent: ["Catalogue"],
        status: 200,
      },
    },
    {
      code: "forbidden-content",
      input: {
        contentType: "text/html",
        forbiddenContent: ["private account"],
        html: "<main>private account</main>",
        requiredContent: ["<main"],
        status: 200,
      },
    },
  ] as const)("reports $code", ({ code, input }) => {
    try {
      assertSsrDocument(input);
      throw new TypeError("Expected the SSR document assertion to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SsrDocumentAssertionError);
      expect(error).toMatchObject({ code });
    }
  });
});
