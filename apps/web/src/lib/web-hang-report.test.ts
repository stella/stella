import { afterEach, expect, mock, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { reportWebPageHang } from "./web-hang-report";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("hang reports send only the lifecycle phase to the versioned API without browser credentials or a referrer", async () => {
  const send = mock(async () => Response.json({ accepted: true }));
  globalThis.fetch = Object.assign(send, {
    preconnect: originalFetch.preconnect,
  });

  const assertRequest = async (
    phase: Parameters<typeof reportWebPageHang>[0],
  ) => {
    await reportWebPageHang(phase);
    expect(send).toHaveBeenLastCalledWith(
      "http://localhost:3001/v1/client-telemetry/web-page-hang",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase }),
        keepalive: true,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      },
    );
  };
  await assertRequest("boot");
  await assertRequest("session");
  expect(send).toHaveBeenCalledTimes(2);
});

test("hang reports propagate rejected HTTP responses to the detector", async () => {
  const send = mock(async () => new Response(null, { status: 429 }));
  globalThis.fetch = Object.assign(send, {
    preconnect: originalFetch.preconnect,
  });

  expect(await rejectionOf(reportWebPageHang("boot"))).toMatchObject({
    message: "Hang report rejected",
    _tag: "WebHangReportError",
  });
  expect(send).toHaveBeenCalledTimes(1);
});

test("hang reports propagate a transport failure without retrying", async () => {
  const failure = new TypeError("Transport unavailable");
  const send = mock(async () => {
    throw failure;
  });
  globalThis.fetch = Object.assign(send, {
    preconnect: originalFetch.preconnect,
  });

  expect(await rejectionOf(reportWebPageHang("session"))).toBe(failure);
  expect(send).toHaveBeenCalledTimes(1);
});
