import { Result } from "better-result";
import { expect, test } from "bun:test";

import type { SoftLawAccessPolicy } from "@/api/lib/legal-search/soft-law-types";

import {
  createSoftLawFetch,
  detectSoftLawBlock,
  SoftLawBlockedError,
  SoftLawAccessError,
  SoftLawContentTypeMismatchError,
  softLawAccessWindowOpen,
} from "./publisher-access";

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
        return new Response(body, { status });
      },
    });
    await expect(fetch("https://uoou.gov.cz/document")).rejects.toBeInstanceOf(
      SoftLawBlockedError,
    );
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
      (await fetch("https://uoou.gov.cz/document")).bytes,
    ),
  ).toBe("document");
  expect(seen).toEqual([policy.userAgent]);
  await expect(fetch("https://example.test/document")).rejects.toBeInstanceOf(
    SoftLawAccessError,
  );
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
  await expect(redirect("https://uoou.gov.cz/document")).rejects.toBeInstanceOf(
    SoftLawAccessError,
  );
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
  await expect(fetch("https://uoou.gov.cz/document")).rejects.toBeInstanceOf(
    SoftLawAccessError,
  );
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
  expect((await fetch("https://uoou.gov.cz/listing")).bytes).toEqual(bytes);
});

test("binary response bytes cannot trigger a text challenge", async () => {
  for (const [url, contentType] of [
    ["https://uoou.gov.cz/media/document.pdf", "application/pdf"],
    ["https://uoou.gov.cz/page", "application/pdf"],
  ]) {
    const fetch = createSoftLawFetch({
      policy,
      signal: new AbortController().signal,
      reserve: async () => {},
      request: async () =>
        new Response("Verify you are human", {
          headers: { "content-type": contentType },
        }),
    });
    expect((await fetch(url)).bytes.byteLength).toBeGreaterThan(0);
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
    await expect(fetch(url)).rejects.toBeInstanceOf(SoftLawBlockedError);
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
  await expect(
    fetch("https://uoou.gov.cz/media/document.pdf", {
      expectedContentTypes: ["application/pdf"],
    }),
  ).rejects.toBeInstanceOf(SoftLawContentTypeMismatchError);
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
        throw new SoftLawAccessError({ message: "Lease lost" });
      }
    },
    request: async () => {
      requests++;
      return new Response("body");
    },
  });
  await expect(fetch("https://uoou.gov.cz/page")).rejects.toBeInstanceOf(
    SoftLawAccessError,
  );
  ownsLease = true;
  await expect(fetch("https://uoou.gov.cz/page")).rejects.toBeInstanceOf(
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
    },
    request: async () => {
      requests++;
      return new Response("blocked", { status: 429 });
    },
  });
  const slow = Result.tryPromise(() => fetch("https://uoou.gov.cz/slow"));
  await checking;
  try {
    await expect(fetch("https://uoou.gov.cz/fast")).rejects.toBeInstanceOf(
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
    await expect(fetch("https://uoou.gov.cz/page")).rejects.toBeInstanceOf(
      SoftLawBlockedError,
    );
  }
  expect(fetch.getBlockReason()).toBe("challenge");
  expect(calls).toBe(1);
});
