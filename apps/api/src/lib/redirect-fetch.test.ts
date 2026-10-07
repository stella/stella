import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  fetchBytesFollowingRedirects,
  fetchStreamFollowingRedirects,
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

describe("streamed redirect lifecycle", () => {
  test("rejects invalid redirect budgets before fetching", async () => {
    for (const maxHops of [
      -1,
      Number.NaN,
      Infinity,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      let fetched = false;
      expect(
        await rejectionOf(
          fetchBytesFollowingRedirects({
            url: "https://publisher.test/start",
            maxHops,
            fetchBytes: async () => {
              fetched = true;
              return Result.ok(response(200));
            },
          }),
        ),
      ).toMatchObject({
        message: "redirect hop limit must be a nonnegative safe integer",
      });
      expect(fetched).toBe(false);
    }
  });
  test("cancels intermediate bodies and leaves the successful stream readable", async () => {
    let cancellations = 0;
    const visited: string[] = [];
    const result = await fetchStreamFollowingRedirects({
      url: "https://publisher.test/start",
      maxHops: 2,
      fetchStream: async (url) => {
        visited.push(url);
        const done = url === "https://object.test/final";
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("payload"));
            if (done) {
              controller.close();
            }
          },
          cancel() {
            cancellations += 1;
          },
        });
        return Result.ok({
          status: done ? 200 : 302,
          ok: done,
          headers: new Headers(
            done
              ? {}
              : {
                  location:
                    visited.length === 1
                      ? "https://object.test/moved"
                      : "/final",
                },
          ),
          body,
        });
      },
    });
    expect(await new Response(result.unwrap().body).text()).toBe("payload");
    expect(cancellations).toBe(2);
    expect(visited).toEqual([
      "https://publisher.test/start",
      "https://object.test/moved",
      "https://object.test/final",
    ]);
  });

  test("releases redirect bodies on every terminal chain failure", async () => {
    for (const scenario of ["loop", "missing", "invalid", "cancel"] as const) {
      let fetched = 0;
      let cancelled = 0;
      const result = await fetchStreamFollowingRedirects({
        url: "https://publisher.test/start?token=secret",
        maxHops: 2,
        fetchStream: async () => {
          fetched += 1;
          return Result.ok({
            body: new ReadableStream<Uint8Array>({
              cancel() {
                cancelled += 1;
                if (scenario === "cancel") {
                  throw new Error("secret");
                }
              },
            }),
            status: 302,
            ok: false,
            headers: new Headers(
              scenario === "missing"
                ? {}
                : {
                    location:
                      scenario === "invalid" ? "http://[invalid" : "/start",
                  },
            ),
          });
        },
      });
      expect(result.isErr()).toBe(true);
      expect(cancelled).toBe(fetched);
      expect(fetched).toBe(scenario === "loop" ? 3 : 1);
      if (result.isErr()) {
        expect(result.error.message).not.toContain("secret");
        expect(result.error.code).toBe(
          {
            loop: "too_many_redirects",
            missing: "missing_location",
            invalid: "invalid_location",
            cancel: "body_cancel_failed",
          }[scenario],
        );
      }
    }
  });
});
