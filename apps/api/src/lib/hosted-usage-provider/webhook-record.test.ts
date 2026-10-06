import { expect, test } from "bun:test";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import {
  HOSTED_USAGE_HANDLED_EVENT_TYPES,
  type HostedUsageEntitlementPayload,
  type HostedUsageAllocationPayload,
} from "@/api/lib/hosted-usage-provider/event-schemas";
import { minimalWebhookRecord } from "@/api/lib/hosted-usage-provider/webhook-record";

const metadata = {
  organization_id: "org-1",
  seat_user_id: "seat-1",
} satisfies Required<NonNullable<HostedUsageEntitlementPayload["metadata"]>>;

const entitlement = {
  id: "subscription-1",
  account_ref: "account-1",
  policy_ref: "product-1",
  status: "active",
  current_period_start: "2026-10-01T00:00:00Z",
  current_period_end: "2026-11-01T00:00:00Z",
  cancel_at_period_end: false,
  quantity: 2,
  created_at: "2026-10-01T00:00:00Z",
  occurred_at: "2026-10-02T00:00:00Z",
  metadata,
} satisfies Required<HostedUsageEntitlementPayload>;

const allocation = {
  occurred_at: "2026-10-02T00:00:00Z",
  id: "order-1",
  account_ref: "account-1",
  policy_ref: "product-1",
  allocation_reason: "addon",
  metadata,
} satisfies Required<HostedUsageAllocationPayload>;

const extra = {
  name: "Example Person",
  email: "person@example.test",
  address: { city: "Example" },
  card: { last4: "1234" },
  tax_id: "example-tax-id",
};

for (const type of HOSTED_USAGE_HANDLED_EVENT_TYPES) {
  test(`stores exactly the dispatch contract for ${type}`, () => {
    const data = type === "allocation.created" ? allocation : entitlement;
    const event =
      type === "allocation.created"
        ? {
            type,
            data: {
              ...allocation,
              ...extra,
              metadata: { ...metadata, ...extra },
            },
            ...extra,
          }
        : {
            type,
            data: {
              ...entitlement,
              ...extra,
              metadata: { ...metadata, ...extra },
            },
            ...extra,
          };
    const rawBody = JSON.stringify(event);
    const record = minimalWebhookRecord({ rawBody, payload: event, event });
    expect(record).toEqual({
      type,
      data,
      signatureVerified: true,
      payloadDigest: hashSha256Hex(rawBody),
    });
  });
}

test("unhandled receipts retain only review identifiers and timestamps", () => {
  const payload = {
    type: "event.unknown",
    delivery_api_version: "version-1",
    timestamp: "2026-10-01T00:00:00Z",
    data: {
      ...extra,
      id: "record-1",
      customer_id: "account-1",
      status: "pending",
    },
    ...extra,
  };
  const rawBody = JSON.stringify(payload);
  expect(minimalWebhookRecord({ rawBody, payload, event: null })).toEqual({
    delivery_api_version: "version-1",
    timestamp: payload.timestamp,
    data: { id: "record-1", customer_id: "account-1", status: "pending" },
    signatureVerified: true,
    payloadDigest: hashSha256Hex(rawBody),
  });
});

test("digest identifies the signed bytes rather than the projection", () => {
  const payload = { type: "event.unknown", data: extra };
  const compact = JSON.stringify(payload);
  const spaced = JSON.stringify(payload, null, 2);
  const record = minimalWebhookRecord({
    rawBody: compact,
    payload,
    event: null,
  });
  expect(
    minimalWebhookRecord({ rawBody: spaced, payload, event: null })[
      "payloadDigest"
    ],
  ).not.toBe(record["payloadDigest"]);
});

test("unhandled identifiers survive malformed optional siblings", () => {
  for (const timestamp of [123, null, [], {}]) {
    for (const status of [123, null, [], {}]) {
      const payload = {
        timestamp,
        data: { id: "record-1", status, customer_id: "account-1" },
      };
      const record = minimalWebhookRecord({
        rawBody: JSON.stringify(payload),
        payload,
        event: null,
      });
      expect(record["data"]).toMatchObject({
        id: "record-1",
        customer_id: "account-1",
      });
      expect(JSON.stringify(record)).not.toContain('"status"');
      expect(JSON.stringify(record)).not.toContain('"timestamp"');
    }
  }
});

test("every dispatch payload read survives the stored projection", async () => {
  const source = await Bun.file(
    new URL("../../handlers/hosted-usage-webhook/dispatch.ts", import.meta.url),
  ).text();
  const kept = new Set([
    ...Object.keys(entitlement),
    ...Object.keys(allocation),
  ]);
  const reads = [...source.matchAll(/\bpayload\.(\w+)/gu)].map((match) =>
    match.at(1),
  );
  expect(reads.length).toBeGreaterThan(0);
  for (const field of reads) {
    expect(kept.has(field ?? "")).toBe(true);
  }
  const metadataReads = [...source.matchAll(/\bpayload\.metadata\?\.(\w+)/gu)];
  for (const match of metadataReads) {
    expect(Object.hasOwn(metadata, match.at(1) ?? "")).toBe(true);
  }
});
