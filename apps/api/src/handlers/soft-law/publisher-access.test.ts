import { expect, test } from "bun:test";

import type { SoftLawAccessPolicy } from "@/api/lib/legal-search/soft-law-types";

import {
  createSoftLawFetch,
  detectSoftLawBlock,
  SoftLawBlockedError,
  SoftLawAccessError,
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
    '<div class="g-recaptcha">',
    "https://example.awswaf.com/challenge",
    "Verify you are human",
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
      beforeRequest: async () => {},
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
    beforeRequest: async () => {},
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
    beforeRequest: async () => {},
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
    beforeRequest: async () => {},
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
});
