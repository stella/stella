import { Result } from "better-result";
import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import {
  createExactIconOrigin,
  createLinkIconOrigin,
  isCanonicalIconHostname,
  toRegistrableIconSite,
} from "@/api/handlers/chat/link-icons/origin";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { validateOutboundFetchTarget } from "@/api/lib/safe-outbound-fetch";

type FetchBytes = typeof safeOutboundFetchBytes;
const iconSite = (hostname: string) => toRegistrableIconSite(hostname).unwrap();

const redirectResponse = (location: string) =>
  Result.ok({
    status: 302,
    ok: false,
    body: new ArrayBuffer(0),
    headers: new Headers({ location }),
  });

const pngChunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length);
  body.copy(result, 4);
  result.writeUInt32BE(Bun.hash.crc32(body), 8 + data.length);
  return result;
};
const pngHeader = Buffer.alloc(13);
pngHeader.writeUInt32BE(1);
pngHeader.writeUInt32BE(1, 4);
pngHeader.writeUInt8(8, 8);
pngHeader.writeUInt8(6, 9);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", pngHeader),
  pngChunk("IDAT", deflateSync(Buffer.alloc(5))),
  pngChunk("IEND", Buffer.alloc(0)),
]);

test("exact icon fetch preserves the normalized path and query", async () => {
  const requests: string[] = [];
  const origin = createExactIconOrigin({
    fetchBytes: async ({ url }) => {
      requests.push(url);
      return Result.ok({
        status: 200,
        ok: true,
        body: PNG_BYTES.buffer,
        headers: new Headers({ "content-type": "image/png" }),
      });
    },
  });
  expect(
    await origin(
      "https://cdn.example.com/icons/one.png?version=2",
      grantThirdPartyOutboundPermit(),
    ),
  ).toMatchObject({ type: "icon" });
  expect(requests).toEqual(["https://cdn.example.com/icons/one.png?version=2"]);
});

test("exact icon input rejects unsafe URLs before fetching", async () => {
  let calls = 0;
  const origin = createExactIconOrigin({
    fetchBytes: async () => {
      calls += 1;
      return Result.ok({
        status: 200,
        ok: true,
        body: PNG_BYTES.buffer,
        headers: new Headers({ "content-type": "image/png" }),
      });
    },
  });
  const permit = grantThirdPartyOutboundPermit();
  for (const url of [
    "http://example.com/icon.png",
    "https://user:pass@example.com/icon.png",
    "https://127.0.0.1/icon.png",
  ]) {
    expect(await origin(url, permit)).toEqual({ type: "no-icon" });
  }
  expect(calls).toBe(0);
});

test("exact icon input refuses oversized and non-image responses", async () => {
  const bodies = [
    new Uint8Array(65_537),
    new TextEncoder().encode("not image"),
  ];
  const origin = createExactIconOrigin({
    fetchBytes: async () =>
      Result.ok({
        status: 200,
        ok: true,
        body: bodies.shift()?.buffer ?? new ArrayBuffer(0),
        headers: new Headers({ "content-type": "image/png" }),
      }),
  });
  const permit = grantThirdPartyOutboundPermit();
  expect(await origin("https://example.com/large.png", permit)).toEqual({
    type: "no-icon",
  });
  expect(await origin("https://example.com/text.png", permit)).toEqual({
    type: "no-icon",
  });
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
  expect(Result.isError(toRegistrableIconSite("xn--a.com"))).toBe(true);
  expect(calls).toBe(0);
  await origin(iconSite("example.com"), grantThirdPartyOutboundPermit());
  expect(calls).toBe(1);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP redirect ${status} cannot send the icon fetch to an unencrypted target`, async () => {
    const requests: string[] = [];
    const origin = createLinkIconOrigin({
      fetchBytes: async ({ url }) => {
        requests.push(url);
        return Result.ok({
          status,
          ok: false,
          body: new ArrayBuffer(0),
          headers: new Headers({ location: "http://example.com/favicon.ico" }),
        });
      },
    });
    expect(
      await origin(iconSite("example.com"), grantThirdPartyOutboundPermit()),
    ).toEqual({
      type: "no-icon",
    });
    expect(requests).toEqual(["https://example.com/favicon.ico"]);
  });
}

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
  expect(
    await origin(iconSite("example.com"), grantThirdPartyOutboundPermit()),
  ).toEqual({
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
  expect(
    await origin(iconSite("example.com"), grantThirdPartyOutboundPermit()),
  ).toEqual({
    type: "temporary",
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
  expect(
    await origin(iconSite("example.com"), grantThirdPartyOutboundPermit()),
  ).toEqual({
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
  const first = origin(iconSite("example.com"), permit);
  const second = origin(iconSite("example.org"), permit);
  expect(await origin(iconSite("example.net"), permit)).toEqual({
    type: "temporary",
  });
  expect(calls).toBe(2);
  finish?.();
  await Promise.all([first, second]);
  await origin(iconSite("example.net"), permit);
  expect(calls).toBe(3);
});

for (const status of [408, 425, 429, 500, 501, 502, 503, 504, 599]) {
  test(`HTTP ${status} is temporary rather than evidence of a missing icon`, async () => {
    const origin = createLinkIconOrigin({
      fetchBytes: async () =>
        Result.ok({
          status,
          ok: false,
          body: new ArrayBuffer(0),
          headers: new Headers(),
        }),
    });
    expect(
      await origin(iconSite("example.com"), grantThirdPartyOutboundPermit()),
    ).toEqual({ type: "temporary" });
  });
}
