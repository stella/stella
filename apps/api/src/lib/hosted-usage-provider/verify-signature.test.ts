import { describe, expect, test } from "bun:test";

import { verifyWebhookSignature } from "@/api/lib/hosted-usage-provider/verify-signature";

const SECRET = "test-secret-please-rotate-in-prod-deadbeefcafe";

const signWithKey = (
  key: string | Buffer,
  id: string,
  timestamp: string,
  body: string,
): string => {
  const payload = `${id}.${timestamp}.${body}`;
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(payload);
  return hasher.digest("base64");
};

const sign = (id: string, timestamp: string, body: string): string =>
  signWithKey(SECRET, id, timestamp, body);

const validHeaders = ({
  id = "evt_test_001",
  timestamp = "1717400000",
  body = `{"type":"entitlement.created"}`,
}: { id?: string; timestamp?: string; body?: string } = {}) => ({
  id,
  timestamp,
  signature: `v1,${sign(id, timestamp, body)}`,
});

describe("verifyWebhookSignature", () => {
  test("returns ok for a correctly signed payload within tolerance", () => {
    const body = `{"type":"entitlement.created","id":"sub_1"}`;
    const headers = validHeaders({ body });
    const result = verifyWebhookSignature({
      secrets: [SECRET],
      rawBody: body,
      headers,
      nowSeconds: 1_717_400_000,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts a Standard Webhooks serialized symmetric secret", () => {
    const secretBytes = Buffer.from(
      "serialized-webhook-secret-32-bytes",
      "utf-8",
    );
    const serializedSecret = `whsec_${secretBytes.toString("base64")}`;
    const id = "evt_serialized_secret_001";
    const timestamp = "1717400000";
    const body = `{"type":"entitlement.created","id":"sub_serialized"}`;
    const signature = signWithKey(secretBytes, id, timestamp, body);

    const result = verifyWebhookSignature({
      secrets: [serializedSecret],
      rawBody: body,
      headers: {
        id,
        timestamp,
        signature: `v1,${signature}`,
      },
      nowSeconds: 1_717_400_000,
    });

    expect(result.ok).toBe(true);
  });

  test("rejects request missing webhook-id header", () => {
    const headers = validHeaders();
    const result = verifyWebhookSignature({
      secrets: [SECRET],
      rawBody: `{"type":"entitlement.created"}`,
      headers: { ...headers, id: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing_headers");
    }
  });

  test("rejects request missing webhook-signature header", () => {
    const headers = validHeaders();
    const result = verifyWebhookSignature({
      secrets: [SECRET],
      rawBody: `{"type":"entitlement.created"}`,
      headers: { ...headers, signature: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing_headers");
    }
  });

  test("rejects malformed serialized secrets instead of treating them as raw strings", () => {
    const malformedSecret = "whsec_not-valid-base64!";
    const id = "evt_malformed_secret_001";
    const timestamp = "1717400000";
    const body = `{"type":"entitlement.created"}`;
    const signature = signWithKey(malformedSecret, id, timestamp, body);

    const result = verifyWebhookSignature({
      secrets: [malformedSecret],
      rawBody: body,
      headers: {
        id,
        timestamp,
        signature: `v1,${signature}`,
      },
      nowSeconds: 1_717_400_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_matching_signature");
    }
  });

  test("rejects payload with mutated body (signature no longer matches)", () => {
    const body = `{"type":"entitlement.created","id":"sub_1"}`;
    const tampered = `{"type":"entitlement.created","id":"sub_2"}`;
    const headers = validHeaders({ body });
    const result = verifyWebhookSignature({
      secrets: [SECRET],
      rawBody: tampered,
      headers,
      nowSeconds: 1_717_400_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_matching_signature");
    }
  });

  test("rejects payload with wrong secret", () => {
    const body = `{"type":"entitlement.created"}`;
    const headers = validHeaders({ body });
    const result = verifyWebhookSignature({
      secrets: ["not-the-real-secret"],
      rawBody: body,
      headers,
      nowSeconds: 1_717_400_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_matching_signature");
    }
  });

  test("rejects malformed timestamp", () => {
    const result = verifyWebhookSignature({
      secrets: [SECRET],
      rawBody: `{"type":"entitlement.created"}`,
      headers: {
        id: "evt_test_001",
        timestamp: "not-a-number",
        signature: "v1,abc",
      },
      nowSeconds: 1_717_400_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed_timestamp");
    }
  });

  test("rejects request whose timestamp is outside the replay tolerance", () => {
    const body = `{"type":"entitlement.created"}`;
    const headers = validHeaders({ body, timestamp: "1717000000" });
    const result = verifyWebhookSignature({
      secrets: [SECRET],
      rawBody: body,
      headers,
      // ~5 hours later — well outside the 5-minute window
      nowSeconds: 1_717_020_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stale_timestamp");
    }
  });

  test("accepts multiple comma-prefixed signatures (rotation)", () => {
    const body = `{"type":"entitlement.created"}`;
    const valid = validHeaders({ body });
    const result = verifyWebhookSignature({
      secrets: [SECRET],
      rawBody: body,
      headers: {
        ...valid,
        signature: `v1,WRONG_OLD_SIG_BASE64== ${valid.signature}`,
      },
      nowSeconds: 1_717_400_000,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts a signature made with the previous secret during rotation", () => {
    const OLD_SECRET = "old-secret-during-rotation-deadbeef";
    const NEW_SECRET = "new-secret-fresh-rotation-cafebabe";
    const id = "evt_rotate_001";
    const timestamp = "1717400000";
    const body = `{"type":"entitlement.created","id":"sub_rotate"}`;

    // Sign with the OLD secret (provider already rotated on their
    // side but we still accept it during our rotation window).
    const oldHasher = new Bun.CryptoHasher("sha256", OLD_SECRET);
    oldHasher.update(`${id}.${timestamp}.${body}`);
    const oldSignature = oldHasher.digest("base64");

    const result = verifyWebhookSignature({
      // Current secret first, previous secret second — same shape
      // as `getWebhookSecret()` returns.
      secrets: [NEW_SECRET, OLD_SECRET],
      rawBody: body,
      headers: {
        id,
        timestamp,
        signature: `v1,${oldSignature}`,
      },
      nowSeconds: 1_717_400_000,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects when neither current nor previous secret matches", () => {
    const body = `{"type":"entitlement.created"}`;
    const headers = validHeaders({ body });
    const result = verifyWebhookSignature({
      secrets: ["wrong-one", "also-wrong"],
      rawBody: body,
      headers,
      nowSeconds: 1_717_400_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_matching_signature");
    }
  });
});
