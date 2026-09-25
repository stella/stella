import { describe, expect, test } from "bun:test";

import { isContainedTabDownload } from "./download-guard";

const containedOrigins = new Set(["https://portal.example.com"]);
const download = (url: string, referrer = "", finalUrl = url) => ({
  finalUrl,
  referrer,
  url,
});

describe("download attribution", () => {
  test("a blob a[download] counts for the page that created it", () => {
    expect(
      isContainedTabDownload({
        containedOrigins,
        download: download("blob:https://portal.example.com/7f0c"),
      }),
    ).toBe(true);
  });

  test("a data: download counts by its referrer, and without one always", () => {
    const data = "data:text/plain;base64,AAAA";
    expect(
      isContainedTabDownload({
        containedOrigins,
        download: download(data, "https://portal.example.com/invoices"),
      }),
    ).toBe(true);
    expect(
      isContainedTabDownload({
        containedOrigins,
        download: download(data, "https://files.example.org/"),
      }),
    ).toBe(false);
    // Nothing says which tab saved it, so it is not risked.
    expect(
      isContainedTabDownload({ containedOrigins, download: download(data) }),
    ).toBe(true);
    expect(
      isContainedTabDownload({
        containedOrigins,
        download: { ...download(data), byExtensionId: "other-extension" },
      }),
    ).toBe(false);
  });

  test("a download from another site's tab is left alone", () => {
    expect(
      isContainedTabDownload({
        containedOrigins,
        download: download(
          "https://files.example.org/report.pdf",
          "https://files.example.org/",
        ),
      }),
    ).toBe(false);
  });
});
