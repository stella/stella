import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import {
  SoftLawBlockedError,
  SoftLawAccessError,
  SoftLawContentTypeMismatchError,
} from "@/api/lib/legal-search/soft-law-access-types";
import type {
  SoftLawFetchError,
  SoftLawResponse,
} from "@/api/lib/legal-search/soft-law-access-types";
import type { SoftLawAccessPolicy } from "@/api/lib/legal-search/soft-law-types";

import {
  createSoftLawFetch,
  detectSoftLawBlock,
  SOFT_LAW_RESPONSE_MAX_BYTES,
  softLawAccessWindowOpen,
} from "./publisher-access";

const fetchError = (result: Result<SoftLawResponse, SoftLawFetchError>) => {
  if (!Result.isError(result)) {
    panic("Expected a classified fetch failure");
  }
  return result.error;
};

const policy = {
  publisherGate: "uoou-cz",
  userAgent: "Stella/1.0 (+https://stella.example/contact)",
  window: { type: "any_time" },
} as const satisfies SoftLawAccessPolicy;

test("status and challenge markup stop access while ordinary guidance remains readable", () => {
  expect(detectSoftLawBlock(403, "")).toBe("forbidden");
  expect(detectSoftLawBlock(429, "")).toBe("rate_limited");
  for (const body of [
    "<title>Just a moment...</title>",
    '<form id="challenge-form">',
    "https://example.awswaf.com/challenge",
    "Verify you are human",
    "cf-chl-platform",
    '<script src="https://hcaptcha.com/1/api.js"></script>',
  ]) {
    expect(detectSoftLawBlock(200, body)).toBe("challenge");
  }
  expect(
    detectSoftLawBlock(200, "Guidance about captcha data processing"),
  ).toBeNull();
});

test("blocked responses are never retried or exposed to parsers", async () => {
  for (const [status, body] of [
    [403, ""],
    [429, ""],
    [200, '<form id="challenge-form">'],
    [503, "<title>Just a moment...</title>"],
  ] as const) {
    let calls = 0;
    const fetch = createSoftLawFetch({
      policy,
      signal: new AbortController().signal,
      reserve: async () => {},
      request: async () => {
        calls++;
        return new Response(body, {
          status,
          headers: { "content-type": "text/html" },
        });
      },
    });
    expect(
      fetchError(
        await fetch("https://uoou.gov.cz/document", { surface: "page" }),
      ),
    ).toBeInstanceOf(SoftLawBlockedError);
    expect(calls).toBe(1);
  }
});

test("network failures return a classified access error without rejecting the fetch promise", async () => {
  const cause = new TypeError("Network unavailable");
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () => {
      throw cause;
    },
  });
  const result = await fetch("https://uoou.gov.cz/document", {
    surface: "page",
  });
  const error = fetchError(result);
  expect(error).toBeInstanceOf(SoftLawAccessError);
  expect(error).toMatchObject({ cause });
  expect(fetch.getBlockReason()).toBeNull();
});

test("blocked status and redirects latch before failing body cleanup", async () => {
  for (const [status, reason] of [
    [403, "forbidden"],
    [429, "rate_limited"],
    [302, "challenge"],
  ] as const) {
    let calls = 0;
    const fetch = createSoftLawFetch({
      policy,
      signal: new AbortController().signal,
      reserve: async () => {},
      request: async () => {
        calls++;
        return new Response(
          new ReadableStream({
            cancel: async () => {
              throw new TypeError("Cleanup failed");
            },
          }),
          { status, headers: { location: "/cdn-cgi/challenge" } },
        );
      },
    });
    expect(
      Result.isError(
        await fetch("https://uoou.gov.cz/document", { surface: "page" }),
      ),
    ).toBe(true);
    expect(fetch.getBlockReason()).toBe(reason);
    expect(
      fetchError(await fetch("https://uoou.gov.cz/other", { surface: "page" })),
    ).toMatchObject({
      reason,
    });
    expect(calls).toBe(1);
  }
});

test("publisher fetch applies the contact user agent, rejects redirects and foreign hosts", async () => {
  const seen: string[] = [];
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async (_url, init) => {
      seen.push(new Headers(init.headers).get("user-agent") ?? "");
      expect(init.redirect).toBe("manual");
      return new Response("document");
    },
  });
  expect(
    new TextDecoder().decode(
      (
        await fetch("https://uoou.gov.cz/document", { surface: "page" })
      ).unwrap().bytes,
    ),
  ).toBe("document");
  expect(seen).toEqual([policy.userAgent]);
  expect(
    fetchError(
      await fetch("https://example.test/document", { surface: "page" }),
    ),
  ).toBeInstanceOf(SoftLawAccessError);
  expect(seen).toHaveLength(1);
  const redirect = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.test/" },
      }),
  });
  expect(
    fetchError(
      await redirect("https://uoou.gov.cz/document", { surface: "page" }),
    ),
  ).toBeInstanceOf(SoftLawAccessError);
});

test("off-peak windows use the declared zone across midnight", () => {
  const night = {
    ...policy,
    window: {
      type: "off_peak",
      timeZone: "Europe/Prague",
      startHour: 22,
      endHour: 6,
    },
  } as const;
  expect(softLawAccessWindowOpen(night, new Date("2026-10-01T21:00:00Z"))).toBe(
    true,
  );
  expect(softLawAccessWindowOpen(night, new Date("2026-10-02T03:00:00Z"))).toBe(
    true,
  );
  expect(softLawAccessWindowOpen(night, new Date("2026-10-02T04:00:00Z"))).toBe(
    false,
  );
  expect(softLawAccessWindowOpen(night, new Date("2026-10-02T19:00:00Z"))).toBe(
    false,
  );
});

test("closed access windows refuse the request after reservation", async () => {
  let calls = 0;
  const fetch = createSoftLawFetch({
    policy: {
      ...policy,
      window: {
        type: "off_peak",
        timeZone: "Europe/Prague",
        startHour: 22,
        endHour: 6,
      },
    },
    signal: new AbortController().signal,
    reserve: async () => {},
    now: () => new Date("2026-10-02T12:00:00Z"),
    request: async () => {
      calls++;
      return new Response("body");
    },
  });
  expect(
    fetchError(
      await fetch("https://uoou.gov.cz/document", { surface: "page" }),
    ),
  ).toBeInstanceOf(SoftLawAccessError);
  expect(calls).toBe(0);
  expect(fetch.getWindowState()).toBe("deferred_window");
});

test("the recorded CMS newsletter CAPTCHA is not a challenge shell", async () => {
  const bytes = Bun.gunzipSync(
    new Uint8Array(
      await Bun.file(
        new URL("__fixtures__/uoou-listing.html.gz", import.meta.url),
      ).arrayBuffer(),
    ),
  );
  const html = new TextDecoder().decode(bytes);
  expect(html).toContain("g-recaptcha u-newsletter__captcha-box");
  expect(detectSoftLawBlock(200, html)).toBeNull();
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () =>
      new Response(html, { headers: { "content-type": "text/html" } }),
  });
  expect(
    (await fetch("https://uoou.gov.cz/listing", { surface: "page" })).unwrap()
      .bytes,
  ).toEqual(bytes);
});

test("binary response bytes cannot trigger a text challenge", async () => {
  for (const [url, contentType] of [
    ["https://uoou.gov.cz/media/document.pdf", "application/pdf"],
    ["https://uoou.gov.cz/page", "application/pdf"],
  ] as const) {
    const fetch = createSoftLawFetch({
      policy,
      signal: new AbortController().signal,
      reserve: async () => {},
      request: async () =>
        new Response("Verify you are human", {
          headers: { "content-type": contentType },
        }),
    });
    expect(
      (await fetch(url, { surface: "page" })).unwrap().bytes.byteLength,
    ).toBeGreaterThan(0);
    expect(fetch.getBlockReason()).toBeNull();
  }
});

test("HTML challenge responses block even at attachment URLs", async () => {
  for (const url of [
    "https://uoou.gov.cz/media/document.docx",
    "https://uoou.gov.cz/document.pdf",
  ]) {
    const fetch = createSoftLawFetch({
      policy,
      signal: new AbortController().signal,
      reserve: async () => {},
      request: async () =>
        new Response("Verify you are human", {
          headers: { "content-type": "text/html" },
        }),
    });
    expect(fetchError(await fetch(url, { surface: "page" }))).toBeInstanceOf(
      SoftLawBlockedError,
    );
    expect(fetch.getBlockReason()).toBe("challenge");
  }
});

test("an expected binary surface answering ordinary HTML is a retryable content-type mismatch", async () => {
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () =>
      new Response("<title>Maintenance</title>", {
        headers: { "content-type": "text/html" },
      }),
  });
  expect(
    fetchError(
      await fetch("https://uoou.gov.cz/media/document.pdf", {
        surface: "attachment",
        expectedContentTypes: ["application/pdf"],
      }),
    ),
  ).toBeInstanceOf(SoftLawContentTypeMismatchError);
  expect(fetch.getBlockReason()).toBeNull();
});

test("lease loss during pacing prevents every later request", async () => {
  let ownsLease = true;
  let requests = 0;
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {
      ownsLease = false;
    },
    beforeRequest: async () => {
      if (!ownsLease) {
        return Result.err(new SoftLawAccessError({ message: "Lease lost" }));
      }
      return Result.ok(undefined);
    },
    request: async () => {
      requests++;
      return new Response("body");
    },
  });
  expect(
    fetchError(await fetch("https://uoou.gov.cz/page", { surface: "page" })),
  ).toBeInstanceOf(SoftLawAccessError);
  ownsLease = true;
  expect(
    fetchError(await fetch("https://uoou.gov.cz/page", { surface: "page" })),
  ).toBeInstanceOf(SoftLawAccessError);
  expect(requests).toBe(0);
  expect(fetch.getLeaseState()).toBe("lost");
});

test("a block arriving during another request's lease check prevents that request", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let leases = 0;
  let requests = 0;
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    beforeRequest: async () => {
      leases++;
      if (leases === 1) {
        entered();
        await pending;
      }
      return Result.ok(undefined);
    },
    request: async () => {
      requests++;
      return new Response("blocked", { status: 429 });
    },
  });
  const slow = fetch("https://uoou.gov.cz/slow", { surface: "page" });
  await checking;
  try {
    expect(
      fetchError(await fetch("https://uoou.gov.cz/fast", { surface: "page" })),
    ).toBeInstanceOf(SoftLawBlockedError);
  } finally {
    release();
  }
  expect(Result.isError(await slow)).toBe(true);
  expect(requests).toBe(1);
});

test("a challenge redirect latches and all later requests are refused", async () => {
  let calls = 0;
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "/cdn-cgi/challenge-platform/" },
      });
    },
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(
      fetchError(await fetch("https://uoou.gov.cz/page", { surface: "page" })),
    ).toBeInstanceOf(SoftLawBlockedError);
  }
  expect(fetch.getBlockReason()).toBe("challenge");
  expect(calls).toBe(1);
});

test("a genuine challenge shell is not exempted by the recorded newsletter CAPTCHA", async () => {
  const original = new Uint8Array(
    Bun.gunzipSync(
      new Uint8Array(
        await Bun.file(
          new URL("__fixtures__/uoou-listing.html.gz", import.meta.url),
        ).arrayBuffer(),
      ),
    ),
  );
  const html = new TextDecoder().decode(original);
  expect(html).toContain("g-recaptcha u-newsletter__captcha-box");
  expect(detectSoftLawBlock(200, html)).toBeNull();

  const readable = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () =>
      new Response(original, {
        headers: { "content-type": "text/html" },
      }),
  });
  expect(
    (
      await readable("https://uoou.gov.cz/listing", { surface: "page" })
    ).unwrap().bytes,
  ).toEqual(original);
  expect(readable.getBlockReason()).toBeNull();

  const challenged = new TextEncoder().encode(
    `<form id="challenge-form">Verify you are human</form>\n${html}`,
  );
  const inspected = new TextDecoder().decode(challenged.subarray(0, 64 * 1024));
  expect(inspected).toContain('id="challenge-form"');
  expect(new TextDecoder().decode(challenged)).toContain(
    "g-recaptcha u-newsletter__captcha-box",
  );
  let requests = 0;
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () => {
      requests++;
      return new Response(challenged, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  expect(
    fetchError(await fetch("https://uoou.gov.cz/listing", { surface: "page" })),
  ).toBeInstanceOf(SoftLawBlockedError);
  expect(fetch.getBlockReason()).toBe("challenge");
  expect(
    fetchError(await fetch("https://uoou.gov.cz/later", { surface: "page" })),
  ).toMatchObject({
    reason: "challenge",
  });
  expect(requests).toBe(1);
});

test("streamed publisher bytes crossing the transport limit are rejected and cancelled", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const totalBytes = SOFT_LAW_RESPONSE_MAX_BYTES + 1;
  expect(chunk.byteLength).toBeLessThan(SOFT_LAW_RESPONSE_MAX_BYTES);
  expect(totalBytes).toBeGreaterThan(SOFT_LAW_RESPONSE_MAX_BYTES);
  let delivered = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        if (delivered === totalBytes) {
          controller.close();
          return;
        }
        const bytes = chunk.subarray(
          0,
          Math.min(chunk.byteLength, totalBytes - delivered),
        );
        delivered += bytes.byteLength;
        controller.enqueue(bytes);
      },
      cancel: () => {
        cancellations++;
      },
    },
    { highWaterMark: 0 },
  );
  const fetch = createSoftLawFetch({
    policy,
    signal: new AbortController().signal,
    reserve: async () => {},
    request: async () =>
      new Response(stream, {
        headers: { "content-type": "application/octet-stream" },
      }),
  });
  const result = await fetch("https://uoou.gov.cz/large-response", {
    surface: "page",
  });
  expect(delivered).toBe(totalBytes);
  const error = fetchError(result);
  expect(error).toBeInstanceOf(SoftLawAccessError);
  expect(error.message).toBe("Publisher response exceeds the byte limit");
  expect(cancellations).toBe(1);
  expect(fetch.getBlockReason()).toBeNull();
});

test("caller abort during a pending publisher body read returns an error and cancels the reader", async () => {
  const readStarted = Promise.withResolvers<undefined>();
  const pendingPull = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  let pulls = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: () => {
        pulls++;
        readStarted.resolve(undefined);
        return pendingPull.promise;
      },
      cancel: () => {
        cancellations++;
        pendingPull.resolve(undefined);
      },
    },
    { highWaterMark: 0 },
  );
  const fetch = createSoftLawFetch({
    policy,
    signal: controller.signal,
    reserve: async () => {},
    request: async () =>
      new Response(stream, {
        headers: { "content-type": "text/html" },
      }),
  });
  const result = fetch("https://uoou.gov.cz/pending-response", {
    surface: "page",
  });
  await readStarted.promise;
  expect(pulls).toBe(1);
  controller.abort(new DOMException("Cancelled by caller", "AbortError"));
  const error = fetchError(await result);
  expect(error).toBeInstanceOf(SoftLawAccessError);
  expect(error.message).toBe("Publisher response body read was aborted");
  expect(cancellations).toBe(1);
  expect(pulls).toBe(1);
  expect(fetch.getBlockReason()).toBeNull();
}, 2000);
