import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { MOBILE_PUSH_DATA_KEY } from "@stll/api-contract/mobile-push";
import type { MobilePushPayload } from "@stll/api-contract/mobile-push";

import {
  ApnsTransportError,
  classifyApnsResponse,
  createApnsClient,
} from "@/api/lib/push/apns-client";
import type {
  ApnsAlert,
  ApnsHttpRequest,
  ApnsHttpResponse,
  ApnsTransport,
} from "@/api/lib/push/apns-client";
import { ApnsProviderTokenError } from "@/api/lib/push/apns-provider-token";
import type { ApnsProviderToken } from "@/api/lib/push/apns-provider-token";

const TOKEN = "ab".repeat(32);

const payload: MobilePushPayload = {
  aps: { alert: { body: "You were mentioned in a comment" }, sound: "default" },
  [MOBILE_PUSH_DATA_KEY]: {
    v: 1,
    kind: "mention",
    notificationId: "0198f7c4-0000-7000-8000-000000000001",
    organizationId: "org-1",
    workspaceId: "ws-1",
    entityType: "entity",
    entityId: "entity-1",
  },
};

const alert = (overrides: Partial<ApnsAlert> = {}): ApnsAlert => ({
  environment: "production",
  token: TOKEN,
  bundleId: "app.stll.mobile",
  payload,
  collapseId: payload[MOBILE_PUSH_DATA_KEY].notificationId,
  ...overrides,
});

/** A gateway that answers every request with `answer` and records them. */
const fakeGateway = (
  answer: Result<ApnsHttpResponse, ApnsTransportError>,
): ApnsTransport & { requests: ApnsHttpRequest[] } => {
  const requests: ApnsHttpRequest[] = [];
  return {
    requests,
    post: async (request) => {
      requests.push(request);
      return await Promise.resolve(answer);
    },
    close: () => undefined,
  };
};

const fixedToken = (): ApnsProviderToken & { expired: number } => {
  const state = {
    expired: 0,
    current: async () => await Promise.resolve(Result.ok("provider-jwt")),
    expire: () => {
      state.expired += 1;
    },
  };
  return state;
};

const response = (status: number, reason?: string): ApnsHttpResponse => ({
  status,
  body: reason === undefined ? "" : JSON.stringify({ reason }),
});

describe("APNs responses", () => {
  test.each([
    [response(200), { type: "delivered" }],
    [
      response(410, "Unregistered"),
      { type: "device_gone", reason: "Unregistered" },
    ],
    [
      response(410, "ExpiredToken"),
      { type: "device_gone", reason: "ExpiredToken" },
    ],
    [
      response(400, "BadDeviceToken"),
      { type: "device_gone", reason: "BadDeviceToken" },
    ],
    [
      response(400, "DeviceTokenNotForTopic"),
      { type: "device_gone", reason: "DeviceTokenNotForTopic" },
    ],
    [
      response(429, "TooManyRequests"),
      { type: "retry", reason: "TooManyRequests" },
    ],
    [
      response(500, "InternalServerError"),
      { type: "retry", reason: "InternalServerError" },
    ],
    [
      response(503, "ServiceUnavailable"),
      { type: "retry", reason: "ServiceUnavailable" },
    ],
    [response(503), { type: "retry", reason: "HTTP 503" }],
    [
      response(403, "ExpiredProviderToken"),
      { type: "retry", reason: "ExpiredProviderToken" },
    ],
    [
      response(403, "InvalidProviderToken"),
      { type: "rejected", reason: "InvalidProviderToken", status: 403 },
    ],
    [
      response(400, "PayloadTooLarge"),
      { type: "rejected", reason: "PayloadTooLarge", status: 400 },
    ],
    [
      response(400, "BadCollapseId"),
      { type: "rejected", reason: "BadCollapseId", status: 400 },
    ],
  ] as const)("%o is %o", (answer, outcome) => {
    expect(classifyApnsResponse(answer)).toEqual(outcome);
  });

  test("a body that is not JSON falls back to the status", () => {
    expect(classifyApnsResponse({ status: 400, body: "<html>" })).toEqual({
      type: "rejected",
      reason: "HTTP 400",
      status: 400,
    });
  });
});

describe("APNs client", () => {
  test("addresses the device on its gateway with Apple's alert headers", async () => {
    const gateway = fakeGateway(Result.ok(response(200)));
    const client = createApnsClient({
      transport: gateway,
      providerToken: fixedToken(),
      now: () => 1_000_000_000_000,
    });

    expect(await client.send(alert())).toEqual({ type: "delivered" });
    expect(await client.send(alert({ environment: "sandbox" }))).toEqual({
      type: "delivered",
    });

    expect(gateway.requests.map(({ origin }) => origin)).toEqual([
      "https://api.push.apple.com",
      "https://api.sandbox.push.apple.com",
    ]);
    const [first] = gateway.requests;
    expect(first?.path).toBe(`/3/device/${TOKEN}`);
    expect(first?.headers).toEqual({
      authorization: "bearer provider-jwt",
      "apns-topic": "app.stll.mobile",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": payload[MOBILE_PUSH_DATA_KEY].notificationId,
      "apns-expiration": String(1_000_000_000 + 24 * 60 * 60),
    });
    expect(JSON.parse(first?.body ?? "")).toEqual(payload);
  });

  test("an expired provider token is dropped and the alert retried", async () => {
    const providerToken = fixedToken();
    const client = createApnsClient({
      transport: fakeGateway(Result.ok(response(403, "ExpiredProviderToken"))),
      providerToken,
    });

    expect(await client.send(alert())).toEqual({
      type: "retry",
      reason: "ExpiredProviderToken",
    });
    expect(providerToken.expired).toBe(1);
  });

  test("a network failure is worth another attempt", async () => {
    const client = createApnsClient({
      transport: fakeGateway(
        Result.err(
          new ApnsTransportError({ message: "timed out", reason: "timeout" }),
        ),
      ),
      providerToken: fixedToken(),
    });

    expect(await client.send(alert())).toEqual({
      type: "retry",
      reason: "timeout",
    });
  });

  test("without a provider token nothing is sent", async () => {
    const gateway = fakeGateway(Result.ok(response(200)));
    const client = createApnsClient({
      transport: gateway,
      providerToken: {
        current: async () =>
          await Promise.resolve(
            Result.err(new ApnsProviderTokenError({ message: "bad key" })),
          ),
        expire: () => undefined,
      },
    });

    expect(await client.send(alert())).toEqual({
      type: "rejected",
      reason: "ProviderTokenUnavailable",
      status: 0,
    });
    expect(gateway.requests).toEqual([]);
  });
});
