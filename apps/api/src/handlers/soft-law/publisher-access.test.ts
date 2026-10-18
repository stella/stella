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
  softLawAccessWindowOpen,
} from "./publisher-access";

const fetchError = (result: Result<SoftLawResponse, SoftLawFetchError>) => {
  if (!Result.isError(result)) {
    return panic("Expected a classified fetch failure");
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
      fetchError(await fetch("https://uoou.gov.cz/document")),
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
  const result = await fetch("https://uoou.gov.cz/document");
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
    expect(Result.isError(await fetch("https://uoou.gov.cz/document"))).toBe(
      true,
    );
    expect(fetch.getBlockReason()).toBe(reason);
    expect(fetchError(await fetch("https://uoou.gov.cz/other"))).toMatchObject({
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
      (await fetch("https://uoou.gov.cz/document")).unwrap().bytes,
    ),
  ).toBe("document");
  expect(seen).toEqual([policy.userAgent]);
  expect(
    fetchError(await fetch("https://example.test/document")),
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
    fetchError(await redirect("https://uoou.gov.cz/document")),
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
    fetchError(await fetch("https://uoou.gov.cz/document")),
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
  expect((await fetch("https://uoou.gov.cz/listing")).unwrap().bytes).toEqual(
    bytes,
  );
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
    expect((await fetch(url)).unwrap().bytes.byteLength).toBeGreaterThan(0);
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
    expect(fetchError(await fetch(url))).toBeInstanceOf(SoftLawBlockedError);
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
  expect(fetchError(await fetch("https://uoou.gov.cz/page"))).toBeInstanceOf(
    SoftLawAccessError,
  );
  ownsLease = true;
  expect(fetchError(await fetch("https://uoou.gov.cz/page"))).toBeInstanceOf(
    SoftLawAccessError,
  );
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
  const slow = fetch("https://uoou.gov.cz/slow");
  await checking;
  try {
    expect(fetchError(await fetch("https://uoou.gov.cz/fast"))).toBeInstanceOf(
      SoftLawBlockedError,
    );
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
    expect(fetchError(await fetch("https://uoou.gov.cz/page"))).toBeInstanceOf(
      SoftLawBlockedError,
    );
  }
  expect(fetch.getBlockReason()).toBe("challenge");
  expect(calls).toBe(1);
});
