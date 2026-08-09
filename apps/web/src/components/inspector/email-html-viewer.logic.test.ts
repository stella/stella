import { describe, expect, test } from "bun:test";

import {
  getEmailAttachmentSize,
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

  test("selects a readable unit for attachment sizes", () => {
    expect(getEmailAttachmentSize(512)).toEqual({ unit: "byte", value: 512 });
    expect(getEmailAttachmentSize(2000)).toEqual({
      unit: "kilobyte",
      value: 2,
    });
    expect(getEmailAttachmentSize(2 * 1000 * 1000)).toEqual({
      unit: "megabyte",
      value: 2,
    });
    expect(getEmailAttachmentSize(2 * 1000 * 1000 * 1000)).toEqual({
      unit: "gigabyte",
      value: 2,
    });
    expect(getEmailAttachmentSize(1_000_000)).toEqual({
      unit: "megabyte",
      value: 1,
    });
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
