import { describe, expect, test } from "bun:test";

import {
  getEmailBodyFrameHeight,
  localizeEmailBodyHtml,
  parseEmailDate,
} from "@/components/inspector/email-html-viewer.logic";
import { EMAIL_BODY_FOLD_KIND } from "@/lib/files/email-preview";

describe("email viewer metadata", () => {
  test("rejects missing and malformed dates without throwing", () => {
    expect(parseEmailDate(null)).toBeNull();
    expect(parseEmailDate("not a date")).toBeNull();
  });

  test("parses valid RFC email dates", () => {
    expect(parseEmailDate("Mon, 02 Jun 2026 10:00:00 +0000")).toEqual(
      new Date("2026-06-02T10:00:00.000Z"),
    );
  });

  test("uses vertical scroll extents to size legacy float layouts", () => {
    expect(
      getEmailBodyFrameHeight({
        body: {
          clientHeight: 120,
          offsetHeight: 120,
          renderedHeight: 120,
          scrollHeight: 480,
          scrollWidth: 120,
        },
        documentElement: {
          clientHeight: 120,
          offsetHeight: 120,
          scrollHeight: 480,
          scrollWidth: 120,
        },
        marginBlockEnd: 12,
        marginBlockStart: 8,
      }),
    ).toBe(500);
  });

  test("does not let horizontal overflow change the iframe height", () => {
    expect(
      getEmailBodyFrameHeight({
        body: {
          clientHeight: 140,
          offsetHeight: 140,
          renderedHeight: 140,
          scrollHeight: 140,
          scrollWidth: 12_000,
        },
        documentElement: {
          clientHeight: 140,
          offsetHeight: 140,
          scrollHeight: 140,
          scrollWidth: 12_000,
        },
        marginBlockEnd: 0,
        marginBlockStart: 0,
      }),
    ).toBe(140);
  });
});

describe("email body fold labels", () => {
  const labels = {
    [EMAIL_BODY_FOLD_KIND.quotedHistory]: {
      hide: "Hide previous messages",
      show: "Show previous messages",
    },
    [EMAIL_BODY_FOLD_KIND.signature]: {
      hide: "Hide signature",
      show: "Show signature",
    },
  };

  test("localizes every declared marker and escapes labels", () => {
    const html = localizeEmailBodyHtml({
      bodyFolds: [
        { id: "fold-0", kind: "quoted-history" },
        { id: "fold-1", kind: "signature" },
      ],
      bodyHtml:
        '<details data-stella-email-fold="quoted-history"><summary data-stella-email-fold-summary="fold-0"></summary><blockquote>History</blockquote></details><details data-stella-email-fold="signature"><summary data-stella-email-fold-summary="fold-1"></summary><p>Name</p></details>',
      labels: {
        ...labels,
        [EMAIL_BODY_FOLD_KIND.signature]: {
          hide: 'Hide "signature"',
          show: "Show <signature>",
        },
      },
    });

    expect(html).toContain("Show previous messages");
    expect(html).toContain("Hide previous messages");
    expect(html).toContain("Show &lt;signature&gt;");
    expect(html).toContain("Hide &quot;signature&quot;");
    expect(html).toContain("History");
    expect(html).toContain("Name");
  });

  test("rejects missing, extra, and duplicate markers", () => {
    expect(() =>
      localizeEmailBodyHtml({
        bodyFolds: [{ id: "fold-0", kind: "quoted-history" }],
        bodyHtml: "<p>No marker</p>",
        labels,
      }),
    ).toThrow("Email fold metadata does not match its body markers");
    expect(() =>
      localizeEmailBodyHtml({
        bodyFolds: [],
        bodyHtml: '<summary data-stella-email-fold-summary="fold-0"></summary>',
        labels,
      }),
    ).toThrow("Email fold metadata does not match its body markers");
    expect(() =>
      localizeEmailBodyHtml({
        bodyFolds: [
          { id: "fold-0", kind: "signature" },
          { id: "fold-0", kind: "signature" },
        ],
        bodyHtml: '<summary data-stella-email-fold-summary="fold-0"></summary>',
        labels,
      }),
    ).toThrow("Email fold metadata does not match its body markers");
  });
});
