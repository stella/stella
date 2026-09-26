import { describe, expect, test } from "bun:test";

import {
  createFallbackTimestampAuthority,
  PdfSigningTimestampUnavailableError,
} from "@/api/lib/pdf-signing/timestamp-authority";
import {
  isTimestampAuthorityUrlList,
  parseTimestampAuthorityUrls,
} from "@/api/lib/pdf-signing/timestamp-authority-urls";

const failing = (url: string) => ({
  authority: {
    timestamp: async () => {
      throw new Error(`${url} is down`);
    },
  },
  url,
});

const answering = (url: string, token: Uint8Array) => ({
  authority: { timestamp: async () => token },
  url,
});

describe("configured timestamp authorities", () => {
  test("keeps the list order and appends the single-authority setting", () => {
    expect(
      parseTimestampAuthorityUrls({
        list: "https://a.example/tsa, https://b.example/tsa\nhttp://c.example",
        single: "https://d.example/tsa",
      }),
    ).toEqual([
      "https://a.example/tsa",
      "https://b.example/tsa",
      "http://c.example",
      "https://d.example/tsa",
    ]);
  });

  test("still reads the single-authority setting on its own", () => {
    expect(
      parseTimestampAuthorityUrls({
        list: undefined,
        single: "https://d.example/tsa",
      }),
    ).toEqual(["https://d.example/tsa"]);
    expect(
      parseTimestampAuthorityUrls({ list: undefined, single: undefined }),
    ).toEqual([]);
  });

  test("lists an authority named in both settings once, at its first place", () => {
    expect(
      parseTimestampAuthorityUrls({
        list: "https://a.example/tsa,https://b.example/tsa",
        single: "https://a.example/tsa",
      }),
    ).toEqual(["https://a.example/tsa", "https://b.example/tsa"]);
  });

  test("rejects a list with an entry that is not an http(s) URL", () => {
    expect(isTimestampAuthorityUrlList("https://a.example, ftp://b")).toBe(
      false,
    );
    expect(isTimestampAuthorityUrlList("https://a.example, nonsense")).toBe(
      false,
    );
    expect(isTimestampAuthorityUrlList("https://a.example http://b")).toBe(
      true,
    );
  });
});

describe("falling back across timestamp authorities", () => {
  test("uses the first authority that answers and names it", async () => {
    const token = new Uint8Array([1, 2, 3]);
    const authority = createFallbackTimestampAuthority([
      failing("https://a.example/"),
      answering("https://b.example/", token),
      answering("https://c.example/", new Uint8Array([9])),
    ]);

    expect(authority.usedUrl()).toBe(null);
    expect(await authority.timestamp(new Uint8Array(32), "SHA-256")).toBe(
      token,
    );
    expect(authority.usedUrl()).toBe("https://b.example/");
  });

  test("reports every failure, in order, when no authority answers", async () => {
    const authority = createFallbackTimestampAuthority([
      failing("https://a.example/"),
      failing("https://b.example/"),
    ]);

    const failure = await authority
      .timestamp(new Uint8Array(32), "SHA-256")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PdfSigningTimestampUnavailableError);
    if (!PdfSigningTimestampUnavailableError.is(failure)) {
      return;
    }
    expect(failure.failures.map(({ url }) => url)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    expect(authority.usedUrl()).toBe(null);
  });
});
