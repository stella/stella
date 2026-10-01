import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { PublisherPageError, validatePublisherPage } from "./publisher-page";

const context = { adapterKey: "cz-regional", cursor: "2026-01-01:0" };

describe("publisher response contracts", () => {
  const cases = [
    { name: "empty body", body: "", kind: "json", reason: "too-small" },
    {
      name: "whitespace HTML",
      body: " \n\t ",
      kind: "html",
      reason: "too-small",
    },
    {
      name: "declared floor",
      body: "{}",
      kind: "json",
      minBytes: 3,
      reason: "too-small",
    },
    {
      name: "HTML in JSON",
      body: "<html><form></form></html>",
      kind: "json",
      reason: "content-type",
    },
    {
      name: "HTML in XML",
      body: "<html><script></script></html>",
      kind: "xml",
      reason: "content-type",
    },
    {
      name: "wrong declared MIME",
      body: "{}",
      kind: "json",
      headers: new Headers({ "content-type": "text/html" }),
      reason: "content-type",
    },
    {
      name: "rate limit header",
      body: "{}",
      kind: "json",
      headers: new Headers({ "retry-after": "5" }),
      reason: "interstitial",
    },
    {
      name: "meta redirect",
      body: '<html><head><meta http-equiv="REFRESH" content="0;url=/login"></head><body>redirect</body></html>',
      kind: "html",
      reason: "interstitial",
    },
    {
      name: "form only",
      body: "<html><body><form><input></form></body></html>",
      kind: "html",
      reason: "interstitial",
    },
    {
      name: "script only",
      body: "<script>location.reload()</script>",
      kind: "html",
      reason: "interstitial",
    },
    {
      name: "login form",
      body: '<h1>Access</h1><form><input type="password"></form>',
      kind: "html",
      reason: "interstitial",
    },
    {
      name: "truncated JSON",
      body: '{"items":[',
      kind: "json",
      reason: "invalid-syntax",
    },
    {
      name: "missing listing field",
      body: "{}",
      kind: "json",
      shape: (value: unknown) => Array.isArray(value),
      reason: "invalid-shape",
    },
    {
      name: "truncated XML",
      body: "<root><row>",
      kind: "xml",
      reason: "invalid-syntax",
    },
    {
      name: "mismatched XML children",
      body: "<root><row></root>",
      kind: "xml",
      reason: "invalid-syntax",
    },
    {
      name: "missing PDF marker",
      body: "document",
      kind: "pdf",
      reason: "invalid-syntax",
    },
    {
      name: "truncated PDF",
      body: "%PDF-1.7",
      kind: "pdf",
      reason: "invalid-syntax",
    },
    {
      name: "invalid ZIP",
      body: new Uint8Array(22),
      kind: "zip",
      reason: "invalid-syntax",
    },
    {
      name: "truncated ZIP",
      body: new Uint8Array([0x50, 0x4b, 3, 4]),
      kind: "zip",
      reason: "invalid-syntax",
    },
  ] as const;
  for (const fixture of cases) {
    test(`rejects ${fixture.name} with a typed reason`, () => {
      const result = Result.try({
        try: () =>
          validatePublisherPage({
            ...context,
            body: fixture.body,
            expectation: {
              kind: fixture.kind,
              ...("minBytes" in fixture ? { minBytes: fixture.minBytes } : {}),
              ...("shape" in fixture ? { shape: fixture.shape } : {}),
            },
            ...("headers" in fixture ? { headers: fixture.headers } : {}),
          }),
        catch: (error) => error,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(PublisherPageError);
        expect(result.error).toMatchObject({
          ...context,
          reason: fixture.reason,
        });
      }
    });
  }
  test("accepts small valid bodies and structured MIME suffixes", () => {
    expect(
      validatePublisherPage({
        ...context,
        body: "[]",
        expectation: { kind: "json", shape: Array.isArray },
      }),
    ).toEqual([]);
    expect(
      validatePublisherPage({
        ...context,
        body: "{}",
        headers: new Headers({
          "content-type": "application/problem+json; charset=utf-8",
        }),
        expectation: { kind: "json" },
      }),
    ).toEqual({});
    expect(
      validatePublisherPage({
        ...context,
        body: "<r/>",
        expectation: { kind: "xml" },
      }),
    ).toBe("<r/>");
    expect(
      validatePublisherPage({
        ...context,
        body: "<p>x</p>",
        expectation: { kind: "html" },
      }),
    ).toBe("<p>x</p>");
    expect(
      validatePublisherPage({
        ...context,
        body: "<form><table><tr><td>1</td></tr></table></form>",
        expectation: { kind: "html" },
      }),
    ).toBe("<form><table><tr><td>1</td></tr></table></form>");
    expect(
      validatePublisherPage({
        ...context,
        body: "%PDF-1.7\n%%EOF\n",
        expectation: { kind: "pdf" },
      }),
    ).toBe("%PDF-1.7\n%%EOF\n");
  });
  test("accepts a complete publisher archive", async () => {
    const zip = new JSZip();
    zip.file("decision.xml", "<r/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(
      validatePublisherPage({
        ...context,
        body: bytes,
        expectation: { kind: "zip" },
      }),
    ).toBe(bytes);
  });
});
