import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  fetchBytesFollowingRedirects,
  RedirectChainError,
} from "@/api/lib/redirect-fetch";

/**
 * The class this pins: a download path written against a fetcher that
 * refuses redirects works on cached or direct responses and fails the
 * first time the host actually redirects. The chain logic is exercised
 * here against a scripted fetcher, hop by hop.
 */

const response = (
  status: number,
  headers: Record<string, string> = {},
  body = "",
) => {
  const encoded = new TextEncoder().encode(body);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return {
    body: buffer,
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status,
  };
};

const scriptedFetcher = (
  script: Record<string, ReturnType<typeof response>>,
) => {
  const calls: string[] = [];
  const fetchBytes = async (url: string) => {
    calls.push(url);
    const scripted = script[url];
    if (!scripted) {
      throw new Error(`unscripted url: ${url}`);
    }
    return Result.ok(scripted);
  };
  return { calls, fetchBytes };
};

describe("fetchBytesFollowingRedirects", () => {
  test("follows a chain of redirects and validates every hop", async () => {
    const { calls, fetchBytes } = scriptedFetcher({
      "https://a.example/file": response(302, {
        location: "https://b.example/file",
      }),
      "https://b.example/file": response(307, { location: "/moved" }),
      "https://b.example/moved": response(200, {}, "payload"),
    });

    const result = await fetchBytesFollowingRedirects({
      url: "https://a.example/file",
      maxHops: 4,
      fetchBytes,
    });

    expect(Result.isError(result)).toBe(false);
    if (!Result.isError(result)) {
      expect(new TextDecoder().decode(result.value.body)).toBe("payload");
    }
    // Every hop, including the relative-location one, went through the
    // injected fetcher, so target validation saw each of them.
    expect(calls).toEqual([
      "https://a.example/file",
      "https://b.example/file",
      "https://b.example/moved",
    ]);
  });

  test("caps the number of hops", async () => {
    const { fetchBytes } = scriptedFetcher({
      "https://loop.example/": response(302, {
        location: "https://loop.example/",
      }),
    });

    const result = await fetchBytesFollowingRedirects({
      url: "https://loop.example/",
      maxHops: 3,
      fetchBytes,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(RedirectChainError);
      expect(
        result.error instanceof RedirectChainError && result.error.code,
      ).toBe("too_many_redirects");
    }
  });

  test("rejects a redirect without a location header", async () => {
    const { fetchBytes } = scriptedFetcher({
      "https://a.example/": response(302),
    });

    const result = await fetchBytesFollowingRedirects({
      url: "https://a.example/",
      maxHops: 3,
      fetchBytes,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(
        result.error instanceof RedirectChainError && result.error.code,
      ).toBe("missing_location");
    }
  });

  test("propagates fetcher errors without retrying", async () => {
    const calls: string[] = [];
    const result = await fetchBytesFollowingRedirects({
      url: "https://a.example/",
      maxHops: 3,
      fetchBytes: async (url) => {
        calls.push(url);
        return Result.err(new Error("blocked target"));
      },
    });

    expect(Result.isError(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
