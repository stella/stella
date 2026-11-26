import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  browserDownloadOriginSchema,
  storedBrowserDownloadAddress,
} from "./browser-downloads";

describe("where a filed download came from, as stored", () => {
  test("a web address keeps its site and path, and loses credentials, query and fragment", () => {
    expect(
      storedBrowserDownloadAddress(
        "https://member:secret@files.fixture-library.test:8443/doc/1/file.pdf?X-Signature=abc&token=t#page=2",
      ),
    ).toBe("https://files.fixture-library.test:8443/doc/1/file.pdf");
    expect(
      storedBrowserDownloadAddress("http://fixture-library.test/doc?id=7"),
    ).toBe("http://fixture-library.test/doc");
  });

  test("any other address keeps only its scheme", () => {
    expect(
      storedBrowserDownloadAddress("data:application/pdf;base64,JVBERi0="),
    ).toBe("data:");
    expect(
      storedBrowserDownloadAddress(
        "blob:https://fixture-library.test/1c9e0f1e-0000-4000-8000-000000000000",
      ),
    ).toBe("blob:");
  });

  test("the origin schema stores what it parses that way, and refuses what is no address", () => {
    expect(
      v.parse(browserDownloadOriginSchema, {
        downloadedAt: "2026-11-25T09:30:00.000Z",
        pageUrl: "https://fixture-library.test/search?q=notice&session=s1",
        sourceUrl: "https://fixture-library.test/doc/1/file?sig=abc",
      }),
    ).toEqual({
      downloadedAt: "2026-11-25T09:30:00.000Z",
      pageUrl: "https://fixture-library.test/search",
      sourceUrl: "https://fixture-library.test/doc/1/file",
    });
    expect(
      v.is(browserDownloadOriginSchema, {
        downloadedAt: "2026-11-25T09:30:00.000Z",
        pageUrl: null,
        sourceUrl: "not an address",
      }),
    ).toBe(false);
  });
});
