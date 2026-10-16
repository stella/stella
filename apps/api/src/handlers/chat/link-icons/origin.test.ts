import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  createLinkIconOrigin,
  isCanonicalIconHostname,
} from "@/api/handlers/chat/link-icons/origin";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { validateOutboundFetchTarget } from "@/api/lib/safe-outbound-fetch";

type FetchBytes = typeof safeOutboundFetchBytes;
const redirectResponse = (location: string) =>
  Result.ok({
    status: 302,
    ok: false,
    body: new ArrayBuffer(0),
    headers: new Headers({ location }),
  });

test("the redirect target boundary refuses a mixed public and non-public DNS answer", async () => {
  const target = await validateOutboundFetchTarget(
    "https://cdn.example.com/favicon.ico",
    {
      resolveAddresses: async () =>
        Result.ok([
          { address: "1.1.1.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]),
    },
  );
  expect(Result.isError(target)).toBe(true);
  if (Result.isError(target)) {
    expect(target.error.message).toBe("URL host is not allowed");
  }
});

test("accepts canonical ASCII hostnames and refuses IP-shaped input", () => {
  expect(isCanonicalIconHostname("www.example.com")).toBe(true);
  expect(isCanonicalIconHostname("127.0.0.1")).toBe(false);
  expect(isCanonicalIconHostname("Example.com")).toBe(false);
});

test("invalid ASCII IDN labels cannot consume origin capacity", async () => {
  let calls = 0;
  const origin = createLinkIconOrigin({
    fetchBytes: async () => {
      calls += 1;
      return Result.ok({
        status: 404,
        ok: false,
        body: new ArrayBuffer(0),
        headers: new Headers(),
      });
    },
  });
  expect(isCanonicalIconHostname("xn--a.com")).toBe(false);
  expect(await origin("xn--a.com", grantThirdPartyOutboundPermit())).toEqual({
    type: "no-icon",
  });
  expect(calls).toBe(0);
  await origin("example.com", grantThirdPartyOutboundPermit());
  expect(calls).toBe(1);
});

test("refuses a redirect to a non-HTTPS destination before another fetch", async () => {
  let calls = 0;
  const origin = createLinkIconOrigin({
    fetchBytes: async () => {
      calls += 1;
      return redirectResponse("http://example.com/favicon.ico");
    },
  });
  expect(await origin("example.com", grantThirdPartyOutboundPermit())).toEqual({
    type: "no-icon",
  });
  expect(calls).toBe(1);
});

test("bounds redirect hops and shares one remaining deadline", async () => {
  const timeouts: number[] = [];
  let elapsed = 0;
  const fetchBytes: FetchBytes = async ({
    timeout,
    redirect,
    signal,
    headers,
  }) => {
    expect(timeout?.type).toBe("headers");
    timeouts.push(timeout?.ms ?? 0);
    expect(redirect).toBe("manual");
    expect(signal).toBeDefined();
    expect(new Headers(headers).has("cookie")).toBe(false);
    elapsed += 500;
    return redirectResponse("https://cdn.example.com/favicon.ico");
  };
  const origin = createLinkIconOrigin({ fetchBytes, now: () => elapsed });
  expect(await origin("example.com", grantThirdPartyOutboundPermit())).toEqual({
    type: "no-icon",
  });
  expect(timeouts).toEqual([3000, 2500, 2000]);
});

test("does not begin another hop after the total deadline", async () => {
  let elapsed = 0;
  let calls = 0;
  const origin = createLinkIconOrigin({
    now: () => elapsed,
    fetchBytes: async () => {
      elapsed = 3000;
      calls += 1;
      return redirectResponse("https://cdn.example.com/favicon.ico");
    },
  });
  expect(await origin("example.com", grantThirdPartyOutboundPermit())).toEqual({
    type: "no-icon",
  });
  expect(calls).toBe(1);
});

test("redirect bodies consume the same wire byte budget", async () => {
  const limits: number[] = [];
  const origin = createLinkIconOrigin({
    fetchBytes: async ({ maxBytes }) => {
      limits.push(maxBytes);
      return Result.ok({
        status: 302,
        ok: false,
        body: new ArrayBuffer(32_768),
        headers: new Headers({
          location: "https://cdn.example.com/favicon.ico",
        }),
      });
    },
  });
  expect(await origin("example.com", grantThirdPartyOutboundPermit())).toEqual({
    type: "no-icon",
  });
  expect(limits).toEqual([65_536, 32_768]);
});

test("admits at most two concurrent origin requests and releases capacity", async () => {
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const origin = createLinkIconOrigin({
    fetchBytes: async () => {
      calls += 1;
      await gate;
      return Result.ok({
        status: 404,
        ok: false,
        body: new ArrayBuffer(0),
        headers: new Headers(),
      });
    },
  });
  const permit = grantThirdPartyOutboundPermit();
  const first = origin("example.com", permit);
  const second = origin("example.org", permit);
  expect(await origin("example.net", permit)).toEqual({ type: "capacity" });
  expect(calls).toBe(2);
  finish?.();
  await Promise.all([first, second]);
  await origin("example.net", permit);
  expect(calls).toBe(3);
});
