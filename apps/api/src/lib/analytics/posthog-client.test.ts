import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { ServerAnalyticsCaptureParams } from "@/api/lib/analytics/server-analytics";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import { toSafeId } from "@/api/lib/branded-types";
import { APP_COMMIT_SHA, APP_VERSION } from "@/api/lib/version";

import {
  createPostHogAnalytics,
  type PostHogClientOptions,
} from "./posthog-client";

const BatchBodySchema = v.strictObject({
  api_key: v.string(),
  batch: v.array(
    v.strictObject({
      distinct_id: v.string(),
      event: v.string(),
      properties: v.record(v.string(), v.unknown()),
      timestamp: v.string(),
      uuid: v.string(),
    }),
  ),
  sent_at: v.string(),
});

// Strict: a key the client should not send fails the parse.
type BatchBody = v.InferOutput<typeof BatchBodySchema>;

type ReceivedRequest = {
  readonly body: BatchBody;
  readonly headers: Headers;
  readonly path: string;
};

const servers: { stop: (force?: boolean) => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop(true)));
});

/** A real PostHog-shaped endpoint on loopback; `respond` decides each answer. */
const startReceiver = (
  respond: (
    request: ReceivedRequest,
    index: number,
  ) => Promise<Response> | Response = () => Response.json({ status: "Ok" }),
) => {
  const requests: ReceivedRequest[] = [];
  const waiters: { count: number; resolve: (value: undefined) => void }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const compressed = new Uint8Array(await request.arrayBuffer());
      const received: ReceivedRequest = {
        body: v.parse(
          BatchBodySchema,
          JSON.parse(new TextDecoder().decode(Bun.gunzipSync(compressed))),
        ),
        headers: request.headers,
        path: new URL(request.url).pathname,
      };
      requests.push(received);
      for (const waiter of waiters.filter((w) => requests.length >= w.count)) {
        waiter.resolve(undefined);
      }
      return respond(received, requests.length - 1);
    },
  });
  servers.push(server);
  return {
    // A trailing slash, as an operator may configure it.
    host: `${server.url.origin}/`,
    requests,
    received: async (count: number) => {
      if (requests.length >= count) {
        return;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      waiters.push({ count, resolve });
      await promise;
    },
  };
};

const analyticsFor = (host: string, options: PostHogClientOptions = {}) =>
  createPostHogAnalytics("phc_test", host, {
    // Timer and size flushes stay out of the way unless a test asks for them.
    flushAt: 1000,
    flushIntervalMs: 60_000,
    retryDelayMs: 5,
    ...options,
  });

const feedbackEvent = (distinctId: string): ServerAnalyticsCaptureParams => ({
  distinctId,
  event: SERVER_ANALYTICS_EVENTS.feedbackReportSubmitted,
  properties: {
    area: "documents",
    deduplicated: false,
    email_delivery: "delivered",
    github_delivery: "not_configured",
    kind: "bug",
    redactions: 0,
    via: "web",
  },
});

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UUID_V7 =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

const SERVER_STAMPS = {
  $geoip_disable: true,
  $is_server: true,
  $lib: "stella-api",
  $lib_version: APP_VERSION,
};

describe("PostHog server analytics", () => {
  test("posts allowed events to the batch API, gzip-compressed and stamped", async () => {
    const receiver = startReceiver();
    const analytics = analyticsFor(receiver.host);
    const exceptionListEntry = {
      mechanism: { handled: true, synthetic: false, type: "generic" },
      type: "HandlerError",
      value: "",
    } as const;

    analytics.capture({
      distinctId: "user_123",
      event: SERVER_ANALYTICS_EVENTS.exception,
      groups: { organization: "org_123" },
      properties: {
        $exception_level: "error",
        $exception_list: [exceptionListEntry],
        $exception_type: "HandlerError",
        organization_id: "org_123",
      },
    });
    analytics.capture({
      distinctId: "user_123",
      event: "$autocapture",
      properties: { clicked: "secret-button" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately bypasses the public type to exercise the runtime guard.
    } as unknown as ServerAnalyticsCaptureParams);
    await analytics.flush();

    expect(receiver.requests).toHaveLength(1);
    const [request] = receiver.requests;
    expect(request?.path).toBe("/batch/");
    expect(request?.headers.get("content-encoding")).toBe("gzip");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body.api_key).toBe("phc_test");
    expect(request?.body.sent_at).toMatch(ISO_TIMESTAMP);
    const [message] = request?.body.batch ?? [];
    expect(message?.timestamp).toMatch(ISO_TIMESTAMP);
    expect(message?.uuid).toMatch(UUID_V7);
    expect(request?.body.batch).toEqual([
      {
        distinct_id: "user_123",
        event: SERVER_ANALYTICS_EVENTS.exception,
        properties: {
          $exception_level: "error",
          $exception_list: [exceptionListEntry],
          $exception_type: "HandlerError",
          $groups: { organization: "org_123" },
          app_commit: APP_COMMIT_SHA,
          app_version: APP_VERSION,
          organization_id: "org_123",
          ...SERVER_STAMPS,
        },
        timestamp: message?.timestamp ?? "",
        uuid: message?.uuid ?? "",
      },
    ]);
  });

  test("upserts the organization group under the shared group type", async () => {
    const receiver = startReceiver();
    const analytics = analyticsFor(receiver.host);
    const organizationId = toSafeId<"organization">(
      "3f6e0a7e-9f6f-4a53-9a3e-2b8f6f0c9d41",
    );

    analytics.identifyOrganizationGroup({
      organizationId,
      properties: { name: "Acme Legal" },
    });
    await analytics.flush();

    // Pinned as literals on purpose: the group type must equal the browser
    // adapter's, so client and server events land on one profile.
    const [message] = receiver.requests[0]?.body.batch ?? [];
    expect(message?.event).toBe("$groupidentify");
    expect(message?.distinct_id).toBe(`$organization_${organizationId}`);
    expect(message?.properties).toEqual({
      $group_key: organizationId,
      $group_set: { name: "Acme Legal" },
      $group_type: "organization",
      ...SERVER_STAMPS,
    });
  });

  test("gives an event without an identity a fresh id and no person profile", async () => {
    const receiver = startReceiver();
    const analytics = analyticsFor(receiver.host);

    analytics.capture(feedbackEvent(""));
    analytics.capture(feedbackEvent(""));
    await analytics.flush();

    const batch = receiver.requests[0]?.body.batch ?? [];
    expect(batch.map((message) => message.distinct_id)).toEqual([
      expect.stringMatching(UUID_V7),
      expect.stringMatching(UUID_V7),
    ]);
    expect(batch[0]?.distinct_id).not.toBe(batch[1]?.distinct_id);
    expect(
      batch.map((message) => message.properties["$process_person_profile"]),
    ).toEqual([false, false]);
  });

  test("sends on its own once flushAt events are queued", async () => {
    const receiver = startReceiver();
    const analytics = analyticsFor(receiver.host, { flushAt: 2 });

    analytics.capture(feedbackEvent("user_1"));
    analytics.capture(feedbackEvent("user_2"));
    await receiver.received(1);

    expect(
      receiver.requests[0]?.body.batch.map((message) => message.distinct_id),
    ).toEqual(["user_1", "user_2"]);
  });

  test("sends on its own after the flush interval", async () => {
    const receiver = startReceiver();
    const analytics = analyticsFor(receiver.host, { flushIntervalMs: 10 });

    analytics.capture(feedbackEvent("user_1"));
    expect(receiver.requests).toHaveLength(0);
    await receiver.received(1);

    expect(receiver.requests[0]?.body.batch).toHaveLength(1);
  });

  test("splits a flush into batches of the batch size", async () => {
    const receiver = startReceiver();
    // The SDK rule: a batch never holds fewer events than flushAt.
    const analytics = analyticsFor(receiver.host, {
      flushAt: 2,
      maxBatchSize: 2,
    });

    for (const user of ["user_1", "user_2", "user_3", "user_4", "user_5"]) {
      analytics.capture(feedbackEvent(user));
    }
    await analytics.flush();

    expect(
      receiver.requests.map((request) => request.body.batch.length),
    ).toEqual([2, 2, 1]);
  });

  test("halves the batch after a 413 and delivers every event", async () => {
    const receiver = startReceiver((request) =>
      request.body.batch.length > 2
        ? new Response("too large", { status: 413 })
        : Response.json({ status: "Ok" }),
    );
    const analytics = analyticsFor(receiver.host);

    for (const user of ["user_1", "user_2", "user_3", "user_4"]) {
      analytics.capture(feedbackEvent(user));
    }
    await analytics.flush();

    expect(
      receiver.requests.map((request) => request.body.batch.length),
    ).toEqual([4, 2, 2]);
  });

  test("retries a server error and delivers on a later attempt", async () => {
    const receiver = startReceiver((_request, index) =>
      index < 2
        ? new Response("unavailable", { status: 503 })
        : Response.json({ status: "Ok" }),
    );
    const analytics = analyticsFor(receiver.host);

    analytics.capture(feedbackEvent("user_1"));
    await analytics.flush();

    expect(receiver.requests).toHaveLength(3);
    expect(receiver.requests[2]?.body.batch).toEqual(
      receiver.requests[0]?.body.batch ?? [],
    );
  });

  test("drops a batch PostHog rejects and rejects the flush with the status", async () => {
    const receiver = startReceiver((_request, index) =>
      index === 0
        ? new Response("invalid", { status: 400 })
        : Response.json({ status: "Ok" }),
    );
    const analytics = analyticsFor(receiver.host);

    analytics.capture(feedbackEvent("rejected_user"));
    expect(await rejectionOf(analytics.flush())).toMatchObject({
      _tag: "PostHogDeliveryError",
      message:
        "PostHog rejected a batch of 1 events with HTTP 400; the batch is dropped",
      status: 400,
    });
    analytics.capture(feedbackEvent("next_user"));
    await analytics.flush();

    // Not retried, and not sent again with the next flush.
    expect(
      receiver.requests.map((request) =>
        request.body.batch.map((message) => message.distinct_id),
      ),
    ).toEqual([["rejected_user"], ["next_user"]]);
  });

  test("keeps events that never reached PostHog for the next flush", async () => {
    let healthy = false;
    const receiver = startReceiver(async () => {
      if (!healthy) {
        await Bun.sleep(5000);
      }
      return Response.json({ status: "Ok" });
    });
    const analytics = analyticsFor(receiver.host, {
      requestTimeoutMs: 100,
      retryCount: 1,
    });

    analytics.capture(feedbackEvent("user_1"));
    const startedAt = performance.now();
    expect(await rejectionOf(analytics.flush())).toMatchObject({
      _tag: "PostHogDeliveryError",
      message: expect.stringContaining("did not reach"),
    });
    // One attempt and one retry, each cut off by the request timeout.
    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(receiver.requests).toHaveLength(2);

    healthy = true;
    analytics.capture(feedbackEvent("user_2"));
    await analytics.flush();

    expect(
      receiver.requests
        .at(-1)
        ?.body.batch.map((message) => message.distinct_id),
    ).toEqual(["user_1", "user_2"]);
  });

  test("rejects the flush, without throwing from capture, when PostHog is unreachable", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const closedHost = closed.url.origin;
    await closed.stop(true);
    const analytics = analyticsFor(closedHost, { retryCount: 1 });

    analytics.capture(feedbackEvent("user_1"));

    expect(await rejectionOf(analytics.flush())).toMatchObject({
      _tag: "PostHogDeliveryError",
      message: `PostHog batch of 1 events did not reach ${closedHost}/batch/; the events stay queued for the next flush`,
    });
  });
});
