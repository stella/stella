import { describe, expect, test } from "bun:test";

import {
  createFeedbackToken,
  FEEDBACK_TOKEN_TTL_MINUTES,
  verifyFeedbackToken,
} from "@/api/mcp/feedback-token";

const content = {
  kind: "bug",
  sanitizedTitle: "read_document returns empty body",
  sanitizedBody: "Steps: call read_document. Body is empty.",
};

describe("feedback confirmation token", () => {
  test("round-trips: a fresh token verifies against its content", () => {
    const now = 1_000_000;
    const token = createFeedbackToken(content, now);
    expect(verifyFeedbackToken({ token, nowMs: now + 1000, ...content })).toBe(
      true,
    );
  });

  test("rejects an expired token", () => {
    const now = 1_000_000;
    const token = createFeedbackToken(content, now);
    const afterExpiry = now + FEEDBACK_TOKEN_TTL_MINUTES * 60 * 1000 + 1;
    expect(verifyFeedbackToken({ token, nowMs: afterExpiry, ...content })).toBe(
      false,
    );
  });

  test("rejects tampered content (title)", () => {
    const now = 1_000_000;
    const token = createFeedbackToken(content, now);
    expect(
      verifyFeedbackToken({
        token,
        nowMs: now,
        ...content,
        sanitizedTitle: "a different title",
      }),
    ).toBe(false);
  });

  test("rejects tampered content (kind and body)", () => {
    const now = 1_000_000;
    const token = createFeedbackToken(content, now);
    expect(
      verifyFeedbackToken({ token, nowMs: now, ...content, kind: "docs" }),
    ).toBe(false);
    expect(
      verifyFeedbackToken({
        token,
        nowMs: now,
        ...content,
        sanitizedBody: "tampered body",
      }),
    ).toBe(false);
  });

  test("keeps title and body boundaries distinct", () => {
    const now = 1_000_000;
    const token = createFeedbackToken(
      {
        kind: "bug",
        sanitizedTitle: "A",
        sanitizedBody: "B\nC",
      },
      now,
    );

    expect(
      verifyFeedbackToken({
        token,
        nowMs: now,
        kind: "bug",
        sanitizedTitle: "A\nB",
        sanitizedBody: "C",
      }),
    ).toBe(false);
  });

  test("rejects a tampered expiry (extending the window forges the MAC)", () => {
    const now = 1_000_000;
    const token = createFeedbackToken(content, now);
    const [, mac] = token.split(".");
    const farFuture = now + 10 * 60 * 60 * 1000;
    const forged = `${farFuture}.${mac}`;
    expect(verifyFeedbackToken({ token: forged, nowMs: now, ...content })).toBe(
      false,
    );
  });

  test("rejects malformed tokens", () => {
    const now = 1_000_000;
    for (const token of ["", "no-dot", ".abcd", "abc.def", "-1.deadbeef"]) {
      expect(verifyFeedbackToken({ token, nowMs: now, ...content })).toBe(
        false,
      );
    }
  });
});
