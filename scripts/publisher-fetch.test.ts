import { Result } from "better-result";
import { expect, spyOn, test } from "bun:test";

import * as safeOutboundFetch from "@/api/lib/auth/authorized-outbound-fetch";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

import { createPublisherFetch } from "./publisher-fetch";

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 } as const;

const streamResponse = (status: number, headers: Record<string, string> = {}) =>
  Result.ok({
    body: new Response("ok").body ?? new ReadableStream<Uint8Array>(),
    headers: new Headers(headers),
    ok: status < 300,
    status,
  });

test("robots, the resource and each redirect hop connect to their validated addresses", async () => {
  const connections: { url: string; addresses: unknown }[] = [];
  const transport = spyOn(
    safeOutboundFetch,
    "fetchStreamWithResolvedAddress",
  ).mockImplementation(async ({ url, addresses }) => {
    connections.push({ url: url.href, addresses });
    switch (url.pathname) {
      case "/robots.txt":
        return streamResponse(404);
      case "/resource":
        return streamResponse(302, { location: "/final" });
      default:
        return streamResponse(200);
    }
  });

  try {
    const request = createPublisherFetch({
      permit: grantThirdPartyOutboundPermit(),
      resolveAddresses: async () => Result.ok([PUBLIC_ADDRESS]),
    });
    const outcome = await request("http://publisher.test/resource");

    expect(Result.isOk(outcome) && outcome.value.response.status).toBe(200);
    expect(connections).toEqual([
      { url: "http://publisher.test/robots.txt", addresses: [PUBLIC_ADDRESS] },
      { url: "http://publisher.test/resource", addresses: [PUBLIC_ADDRESS] },
      { url: "http://publisher.test/final", addresses: [PUBLIC_ADDRESS] },
    ]);
  } finally {
    transport.mockRestore();
  }
});

test("a request body is refused before the resource connection", async () => {
  const transport = spyOn(
    safeOutboundFetch,
    "fetchStreamWithResolvedAddress",
  ).mockImplementation(async () => streamResponse(404));

  try {
    const request = createPublisherFetch({
      permit: grantThirdPartyOutboundPermit(),
      resolveAddresses: async () => Result.ok([PUBLIC_ADDRESS]),
    });
    const outcome = await Result.tryPromise(async () =>
      request("http://publisher.test/resource", {
        init: { method: "POST", body: "payload" },
      }),
    );

    expect(Result.isOk(outcome) && Result.isOk(outcome.value)).toBe(false);
    expect(transport.mock.calls.map(([{ url }]) => url.pathname)).not.toContain(
      "/resource",
    );
  } finally {
    transport.mockRestore();
  }
});
