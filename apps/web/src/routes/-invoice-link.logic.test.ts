import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

import {
  invoiceLinkFailure,
  invoiceLinkTokenFromHash,
  qrImageSource,
} from "./-invoice-link.logic";

const LINK_KEY = "0f".repeat(32);

describe("invoice link page", () => {
  test("reads the token from the fragment, with or without its hash", () => {
    expect(invoiceLinkTokenFromHash(LINK_KEY)).toBe(LINK_KEY);
    expect(invoiceLinkTokenFromHash(`#${LINK_KEY}`)).toBe(LINK_KEY);
  });

  test("refuses anything that is not a whole token", () => {
    expect(invoiceLinkTokenFromHash("")).toBeNull();
    expect(invoiceLinkTokenFromHash(LINK_KEY.slice(1))).toBeNull();
    expect(invoiceLinkTokenFromHash(`${LINK_KEY}0`)).toBeNull();
    expect(invoiceLinkTokenFromHash(LINK_KEY.toUpperCase())).toBeNull();
  });

  test("names a dead link, a busy server, and anything else apart", () => {
    expect(
      invoiceLinkFailure(new APIError({ status: 404, message: "gone" })),
    ).toBe("unavailable");
    expect(
      invoiceLinkFailure(new APIError({ status: 429, message: "slow" })),
    ).toBe("busy");
    expect(
      invoiceLinkFailure(new APIError({ status: 500, message: "boom" })),
    ).toBe("error");
    expect(invoiceLinkFailure(new TypeError("offline"))).toBe("error");
  });

  test("encodes the QR markup into an image source", () => {
    const source = qrImageSource(
      '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>',
    );
    expect(source.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(source).not.toContain("<");
    expect(decodeURIComponent(source.split(",")[1] ?? "")).toContain("<svg");
  });
});
