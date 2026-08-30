import { describe, expect, test } from "bun:test";

import {
  crossOriginIsolationHeadersForRequest,
  withCrossOriginIsolationHeaders,
} from "../../cross-origin-isolation";

const headersFor = (path: string) =>
  crossOriginIsolationHeadersForRequest(
    new URL(path, "https://my.stll.test"),
    "https://outlook.stll.test",
  );

describe("cross-origin isolation response headers", () => {
  test("keeps ordinary application pages cross-origin isolated", () => {
    expect(headersFor("/matters")).toEqual({
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
  });

  test("allows the Outlook handoff page to message its cross-origin host", () => {
    expect(
      headersFor(
        "/sign-in-outlook?parentOrigin=https%3A%2F%2Foutlook.stll.test",
      ),
    ).toEqual({
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "unsafe-none",
    });
  });

  test("preserves the exception through bounded auth continuations", () => {
    expect(
      headersFor(
        "/auth/two-factor?redirectTo=%2Fauth%2Forganization%3FredirectTo%3D%252Fsign-in-outlook%253FparentOrigin%253Dhttps%25253A%25252F%25252Foutlook.stll.test",
      )["Cross-Origin-Opener-Policy"],
    ).toBe("unsafe-none");
    expect(
      headersFor(
        "/onboarding?redirectTo=%2Fsign-in-outlook%3FparentOrigin%3Dhttps%253A%252F%252Foutlook.stll.test",
      )["Cross-Origin-Opener-Policy"],
    ).toBe("unsafe-none");
  });

  test("does not weaken unrelated or external auth redirects", () => {
    expect(headersFor("/auth")["Cross-Origin-Opener-Policy"]).toBe(
      "same-origin",
    );
    expect(
      headersFor(
        "/sign-in-outlook?parentOrigin=https%3A%2F%2Fattacker.example",
      )["Cross-Origin-Opener-Policy"],
    ).toBe("same-origin");
    expect(
      headersFor(
        "/auth?redirectTo=https%3A%2F%2Fattacker.example%2Fsign-in-outlook%3FparentOrigin%3Dhttps%253A%252F%252Foutlook.stll.test",
      )["Cross-Origin-Opener-Policy"],
    ).toBe("same-origin");
    expect(
      headersFor(
        "/matters?redirectTo=%2Fsign-in-outlook%3FparentOrigin%3Dhttps%253A%252F%252Foutlook.stll.test",
      )["Cross-Origin-Opener-Policy"],
    ).toBe("same-origin");
  });

  test("fails closed for malformed and oversized redirect chains", () => {
    expect(
      headersFor("/auth?redirectTo=http%3A%2F%2F%5B")[
        "Cross-Origin-Opener-Policy"
      ],
    ).toBe("same-origin");
    const oversized = `/sign-in-outlook?parentOrigin=${"x".repeat(2049)}`;
    expect(
      headersFor(`/auth?redirectTo=${encodeURIComponent(oversized)}`)[
        "Cross-Origin-Opener-Policy"
      ],
    ).toBe("same-origin");
  });

  test("the production response wrapper preserves the dialog-flow exception", () => {
    const requestUrl = new URL(
      "/auth?redirectTo=%2Fsign-in-outlook%3FparentOrigin%3Dhttps%253A%252F%252Foutlook.stll.test",
      "https://my.stll.test",
    );
    const response = withCrossOriginIsolationHeaders(
      requestUrl,
      new Response("auth"),
      "https://outlook.stll.test",
    );

    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "unsafe-none",
    );
  });

  test("the production wrapper preserves headers set by the application server", () => {
    const requestUrl = new URL(
      "/sign-in-outlook?parentOrigin=https%3A%2F%2Foutlook.stll.test",
      "https://my.stll.test",
    );
    const response = withCrossOriginIsolationHeaders(
      requestUrl,
      new Response("auth", {
        headers: { "Cross-Origin-Opener-Policy": "unsafe-none" },
      }),
    );

    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "unsafe-none",
    );
  });
});
