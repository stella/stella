import { SQL } from "bun";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import type { Transaction } from "@/api/db/root";
import { hostedUsageWebhookEvents } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  HOSTED_USAGE_WEBHOOK_HEADERS,
  receiveHostedUsageWebhook,
} from "@/api/handlers/hosted-usage-webhook/receive";
import type { WebhookTransactionRunner } from "@/api/lib/hosted-usage-provider/webhook-store";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TEST_SECRET = "test-webhook-secret-deadbeefcafe";

type SignedRequestOptions = {
  body: string;
  eventId: string;
};

const withWebhookConfig = async (fn: () => Promise<void>): Promise<void> => {
  const previousFeatureUsage = env.FEATURE_USAGE;
  const previousSecret = env.HOSTED_USAGE_WEBHOOK_SECRET;
  const previousSecretPrevious = env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS;
  env.FEATURE_USAGE = true;
  env.HOSTED_USAGE_WEBHOOK_SECRET = TEST_SECRET;
  env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = undefined;
  try {
    await fn();
  } finally {
    env.FEATURE_USAGE = previousFeatureUsage;
    env.HOSTED_USAGE_WEBHOOK_SECRET = previousSecret;
    env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = previousSecretPrevious;
  }
};

const buildSignedRequest = ({
  body,
  eventId,
}: SignedRequestOptions): Request => {
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const hasher = new Bun.CryptoHasher("sha256", TEST_SECRET);
  hasher.update(`${eventId}.${timestamp}.${body}`);
  const signature = hasher.digest("base64");
  return new Request("http://api.test/usage/hosted/webhook", {
    method: "POST",
    headers: {
      [HOSTED_USAGE_WEBHOOK_HEADERS.id]: eventId,
      [HOSTED_USAGE_WEBHOOK_HEADERS.timestamp]: timestamp,
      [HOSTED_USAGE_WEBHOOK_HEADERS.signature]: `v1,${signature}`,
    },
  });
};

describe("receiveHostedUsageWebhook", () => {
  test("rejects malformed payloads for handled event types", async () => {
    await withWebhookConfig(async () => {
      const body = JSON.stringify({
        type: "entitlement.created",
        data: { id: "provider_ent_missing_required_fields" },
      });
      const response = await receiveHostedUsageWebhook({
        request: buildSignedRequest({
          body,
          eventId: "evt_malformed_handled",
        }),
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "Malformed payload for handled event type",
      });
    });
  });
});

describe("receiveHostedUsageWebhook — ignored event records", () => {
  let client: Awaited<ReturnType<typeof createTestPglite>>;
  let db: ReturnType<typeof drizzle>;
  const runTransaction: WebhookTransactionRunner = async (fn) =>
    await db.transaction(async (tx) => await fn(asTestRaw<Transaction>(tx)));

  beforeAll(async () => {
    client = await createTestPglite();
    db = drizzle({ client });
  });

  afterAll(async () => {
    await client.close();
  });

  afterEach(() => {
    analytics?.restore();
    logs?.restore();
    analytics = null;
    logs = null;
  });

  let analytics: RecordingAnalytics | null = null;
  let logs: RecordingLogger | null = null;

  const deliver = async (
    eventId: string,
    body: string,
    run: WebhookTransactionRunner = runTransaction,
  ): Promise<Response> =>
    await receiveHostedUsageWebhook({
      request: buildSignedRequest({ body, eventId }),
      body,
      runTransaction: run,
    });

  const storedResults = async (eventId: string) =>
    await db
      .select({ result: hostedUsageWebhookEvents.result })
      .from(hostedUsageWebhookEvents)
      .where(eq(hostedUsageWebhookEvents.eventId, eventId));

  /** Fails the first transaction with `error`, then runs against the database. */
  const failingOnce = (error: Error): WebhookTransactionRunner => {
    let failed = false;
    return async (fn) => {
      if (!failed) {
        failed = true;
        throw error;
      }
      return await runTransaction(fn);
    };
  };

  test("records handled delivery without provider customer details", async () => {
    await withWebhookConfig(async () => {
      const eventId = `evt_minimal_${Bun.randomUUIDv7()}`;
      const data = {
        id: "subscription-fixture",
        status: "active",
        account_ref: "customer-fixture",
        policy_ref: "missing-policy-fixture",
        current_period_start: "2026-10-01T00:00:00Z",
        current_period_end: "2026-11-01T00:00:00Z",
        created_at: "2026-10-01T00:00:00Z",
      };
      const body = JSON.stringify({
        type: "entitlement.created",
        customer: { email: "person@example.test" },
        data: {
          ...data,
          customer: { name: "Example Person", address: "Example Street" },
          card: { last4: "1234" },
          tax_id: "fixture-tax-id",
        },
      });
      expect((await deliver(eventId, body)).status).toBe(200);
      const stored = (
        await db
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, eventId))
      ).at(0);
      expect(stored?.payload).toEqual({
        type: "entitlement.created",
        data,
        signatureVerified: true,
        payloadDigest: hashSha256Hex(body),
      });
      expect(stored?.result).toBe("ignored");
    });
  });

  test("records an event whose payload carries a NUL character", async () => {
    await withWebhookConfig(async () => {
      const eventId = `evt_unknown_${Bun.randomUUIDv7()}`;
      const body = JSON.stringify({
        type: "customer.note_added",
        data: { note: "before\u0000after", "key\u0000": "value" },
      });

      const response = await deliver(eventId, body);

      expect(response.status).toBe(200);
      const [stored] = await db
        .select({ payload: hostedUsageWebhookEvents.payload })
        .from(hostedUsageWebhookEvents)
        .where(eq(hostedUsageWebhookEvents.eventId, eventId));
      expect(stored?.payload).toEqual({
        signatureVerified: true,
        payloadDigest: hashSha256Hex(body),
        data: {},
      });
    });
  });

  test("omits arbitrary provider fields including colliding keys", async () => {
    await withWebhookConfig(async () => {
      const eventId = `evt_unknown_${Bun.randomUUIDv7()}`;
      const body = JSON.stringify({
        type: "customer.note_added",
        data: {
          "a\u0000": "with NUL",
          a: "plain",
          "a\u2400": "with the NUL symbol",
        },
      });

      const response = await deliver(eventId, body);

      expect(response.status).toBe(200);
      const [stored] = await db
        .select({ payload: hostedUsageWebhookEvents.payload })
        .from(hostedUsageWebhookEvents)
        .where(eq(hostedUsageWebhookEvents.eventId, eventId));
      expect(stored?.payload).toEqual({
        signatureVerified: true,
        payloadDigest: hashSha256Hex(body),
        data: {},
      });
    });
  });

  test("answers 500 on a transient database error and records the unchanged redelivery once", async () => {
    await withWebhookConfig(async () => {
      const eventId = `evt_unknown_${Bun.randomUUIDv7()}`;
      const body = JSON.stringify({
        type: "customer.note_added",
        data: { note: "unchanged" },
      });
      const run = failingOnce(
        new SQL.PostgresError("connection closed", {
          code: "ERR_POSTGRES_CONNECTION_CLOSED",
          detail: "",
          hint: "",
          severity: "",
        }),
      );

      expect((await deliver(eventId, body, run)).status).toBe(500);
      expect(await storedResults(eventId)).toEqual([]);

      for (let delivery = 0; delivery < 2; delivery++) {
        expect((await deliver(eventId, body, run)).status).toBe(200);
      }
      expect(await storedResults(eventId)).toEqual([{ result: "ignored" }]);
    });
  });

  test("reports a record the database rejects as invalid data and acknowledges it", async () => {
    await withWebhookConfig(async () => {
      const eventId = `evt_unknown_${Bun.randomUUIDv7()}`;
      const body = JSON.stringify({
        type: "customer.note_added",
        data: { note: "rejected" },
      });
      const run = failingOnce(
        new SQL.PostgresError("invalid input", {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "22P05",
          detail: "",
          hint: "",
          severity: "ERROR",
        }),
      );
      analytics = installRecordingAnalytics();
      logs = installRecordingLogger();

      const response = await deliver(eventId, body, run);

      expect(response.status).toBe(200);
      expect(
        logs
          .at("ERROR")
          .filter(
            ({ message }) =>
              message === "usage_provider.webhook.unknown_event_persist",
          ),
      ).toHaveLength(1);
      expect(analytics.exceptions()).toHaveLength(1);
    });
  });
});
