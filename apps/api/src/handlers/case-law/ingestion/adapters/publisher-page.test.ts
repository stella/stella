import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { ingestionStopKindOf } from "@/api/lib/errors/tagged-errors";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

import { PublisherPageError, validatePublisherPage } from "./publisher-page";

const context = { adapterKey: "cz-regional", cursor: "2026-01-01:0" };

describe("publisher response failure grading inputs", () => {
  const expected = {
    "too-small": "source_unreachable",
    "content-type": "source_unreachable",
    interstitial: "publisher_refusal",
    "invalid-syntax": "adapter_error",
    "invalid-shape": "adapter_error",
  } as const satisfies Record<PublisherPageError["reason"], string>;
  const reasons = [
    "too-small",
    "content-type",
    "interstitial",
    "invalid-syntax",
    "invalid-shape",
  ] as const satisfies readonly PublisherPageError["reason"][];
  const grades = {
    source_unreachable: "transient",
    publisher_refusal: "anticipated",
    adapter_error: "defect",
  } as const;

  test("covers every publisher response rejection", () => {
    expect(Object.keys(expected).toSorted()).toEqual([...reasons].toSorted());
  });

  for (const reason of reasons) {
    test(`classifies ${reason} without losing the publisher outcome`, () => {
      const error = new PublisherPageError({ ...context, reason });
      expect(error.stopKind).toBe(expected[reason]);
      expect(
        gradeFailure(
          readEvidence(error),
          failureSink({ event: "publisher.page.test", expected: [] }),
        ).grade,
      ).toBe(grades[expected[reason]]);
      expect(ingestionStopKindOf(new Error("Wrapped", { cause: error }))).toBe(
        expected[reason],
      );
    });
  }
});

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
      name: "maintenance HTML in JSON",
      body: "<html><body><h1>Service temporarily unavailable</h1></body></html>",
      headers: new Headers({ "content-type": "text/html" }),
      kind: "json",
      reason: "content-type",
      stopKind: "source_unreachable",
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
      name: "rate limit header with empty body",
      body: "",
      kind: "json",
      headers: new Headers({ "retry-after": "5" }),
      reason: "interstitial",
      stopKind: "publisher_refusal",
    },
    {
      name: "rate limit header with wrong MIME",
      body: "<html>Rate limited</html>",
      kind: "json",
      headers: new Headers({
        "retry-after": "5",
        "content-type": "text/html",
      }),
      reason: "interstitial",
      stopKind: "publisher_refusal",
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
      const result = validatePublisherPage({
        ...context,
        body: fixture.body,
        expectation: {
          kind: fixture.kind,
          ...("minBytes" in fixture ? { minBytes: fixture.minBytes } : {}),
          ...("shape" in fixture ? { shape: fixture.shape } : {}),
        },
        ...("headers" in fixture ? { headers: fixture.headers } : {}),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(PublisherPageError);
        expect(result.error).toMatchObject({
          ...context,
          reason: fixture.reason,
          ...("stopKind" in fixture ? { stopKind: fixture.stopKind } : {}),
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
      }).unwrap(),
    ).toEqual([]);
    expect(
      validatePublisherPage({
        ...context,
        body: "{}",
        headers: new Headers({
          "content-type": "application/problem+json; charset=utf-8",
        }),
        expectation: { kind: "json" },
      }).unwrap(),
    ).toEqual({});
    expect(
      validatePublisherPage({
        ...context,
        body: "<r/>",
        expectation: { kind: "xml" },
      }).unwrap(),
    ).toBe("<r/>");
    expect(
      validatePublisherPage({
        ...context,
        body: "<p>x</p>",
        expectation: { kind: "html" },
      }).unwrap(),
    ).toBe("<p>x</p>");
    expect(
      validatePublisherPage({
        ...context,
        body: "<form><table><tr><td>1</td></tr></table></form>",
        expectation: { kind: "html" },
      }).unwrap(),
    ).toBe("<form><table><tr><td>1</td></tr></table></form>");
    expect(
      validatePublisherPage({
        ...context,
        body: "%PDF-1.7\n%%EOF\n",
        expectation: { kind: "pdf" },
      }).unwrap(),
    ).toBe("%PDF-1.7\n%%EOF\n");
  });
  test("accepts a complete publisher archive", async () => {
    const zip = new ZipArchive();
    zip.set("decision.xml", "<r/>");
    const bytes = await zip.generate({ compression: "store" });
    expect(
      validatePublisherPage({
        ...context,
        body: bytes,
        expectation: { kind: "zip" },
      }).unwrap(),
    ).toBe(bytes);
  });
});

test("inherited publisher failures preserve their finite rejection reason", () => {
  for (const [reason, failureReason] of [
    ["too-small", "upstream_unavailable"],
    ["invalid-shape", "tagged_failure"],
  ] as const) {
    const error = new PublisherPageError({ ...context, reason });
    expect(readEvidence(error).nodes.at(0)?.discriminators).toEqual({
      reason,
      failureReason,
    });
  }
});
