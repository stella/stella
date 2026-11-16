/**
 * PostHog capture client speaking the `/batch/` API through the
 * operator-endpoint transport.
 *
 * Events are queued in memory and sent in gzip-compressed batches when the
 * queue reaches `flushAt`, on a timer, and on `flush()` (the API flushes after
 * every logged request). Capturing never waits on the network and never
 * throws, and a failed delivery is logged here rather than rejecting the
 * flush. The delivery rules are the ones the PostHog Node SDK applied for us:
 * per-attempt timeout, fixed-delay retries on 408/429/5xx and network
 * failures, a 413 halving the batch, events kept for the next flush after a
 * network failure, and a bounded queue that drops its oldest event.
 */
import { Result } from "better-result";

import { POSTHOG_ORGANIZATION_GROUP_TYPE } from "@stll/analytics-config";
import { createCoalescedDrain } from "@stll/concurrency/coalesced-drain";
import { Temporal } from "@stll/time";

import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import type {
  ServerAnalytics,
  ServerAnalyticsCaptureParams,
} from "@/api/lib/analytics/server-analytics";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { postToOperatorEndpoint } from "@/api/lib/observability/operator-endpoint-fetch";
import {
  type DeployEnvironment,
  RELEASE_ENVIRONMENT_PROPERTY,
  RELEASE_VERSION_PROPERTY,
} from "@/api/lib/observability/release-failure-contract";
import { APP_COMMIT_SHA, APP_VERSION } from "@/api/lib/version";

/** Library stamp on every event, in place of the SDK's own. */
const LIBRARY_ID = "stella-api";

const ALLOWED_EVENTS = new Set<ServerAnalyticsCaptureParams["event"]>(
  Object.values(SERVER_ANALYTICS_EVENTS),
);

export type PostHogClientOptions = {
  readonly flushAt?: number;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly requestTimeoutMs?: number;
  readonly retryCount?: number;
  readonly retryDelayMs?: number;
};

// The PostHog Node SDK defaults this client replaces.
const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY_MS = 3000;
const PAYLOAD_TOO_LARGE = 413;

type PostHogProperties = Record<string, unknown>;

type PostHogMessage = {
  readonly distinct_id: string;
  readonly event: string;
  readonly properties: PostHogProperties;
  readonly timestamp: string;
  readonly uuid: string;
};

type SendOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "http_status"; readonly status: number }
  | { readonly kind: "network"; readonly errorType: string };

/** Why a batch was not delivered; the flush logs it. */
type DeliveryFailure =
  | { readonly reason: "rejected"; readonly status: number }
  | {
      readonly reason: "drain_failed" | "unreached";
      readonly errorType: string;
    };

// The name, not the class: a request timeout is a DOMException named
// TimeoutError.
const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "UnknownError";

const isRetryable = (outcome: SendOutcome): boolean =>
  outcome.kind === "network" ||
  (outcome.kind === "http_status" &&
    (outcome.status === 408 ||
      outcome.status === 429 ||
      outcome.status >= 500));

/** The host without trailing slashes, as the SDK joined it to `/batch/`. */
const normalizeHost = (host: string): string => {
  let end = host.length;
  while (end > 0 && host[end - 1] === "/") {
    end -= 1;
  }
  return host.slice(0, end);
};

/** ISO 8601 at millisecond precision, the form the PostHog SDK sent. */
const isoNow = (): string =>
  Temporal.Now.instant().toString({ smallestUnit: "millisecond" });

// The deployment environment is required so staging events never count
// toward a production release's health; undefined (local runs) stamps none.
export const createPostHogServerAnalytics = (
  key: string,
  host: string,
  deployEnvironment: DeployEnvironment | undefined,
  options: PostHogClientOptions = {},
): ServerAnalytics => {
  const flushAt = Math.max(options.flushAt ?? DEFAULT_FLUSH_AT, 1);
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxQueueSize = Math.max(
    options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    flushAt,
  );
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const batchUrl = `${normalizeHost(host)}/batch/`;
  const headers = {
    "Content-Encoding": "gzip",
    "Content-Type": "application/json",
    "User-Agent": `${LIBRARY_ID}/${APP_VERSION}`,
  };

  let maxBatchSize = Math.max(
    options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    flushAt,
  );
  let queue: PostHogMessage[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sendOnce = async (body: Uint8Array): Promise<SendOutcome> => {
    const sent = await postToOperatorEndpoint({
      body,
      headers,
      timeout: { type: "headers", ms: requestTimeoutMs },
      url: batchUrl,
    });
    if (sent.isErr()) {
      return { kind: "network", errorType: errorName(sent.error.cause) };
    }
    return sent.value.ok
      ? { kind: "ok" }
      : { kind: "http_status", status: sent.value.status };
  };

  const send = async (batch: readonly PostHogMessage[]) => {
    const body = Bun.gzipSync(
      JSON.stringify({
        // oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- the PostHog batch API authenticates by the public project key in the request body; this string is the request, never a log line
        api_key: key,
        batch,
        sent_at: isoNow(),
      }),
    );
    let outcome = await sendOnce(body);
    for (
      let retry = 0;
      retry < retryCount &&
      outcome.kind !== "ok" &&
      isRetryable(outcome) &&
      !(outcome.kind === "http_status" && outcome.status === PAYLOAD_TOO_LARGE);
      retry += 1
    ) {
      await Bun.sleep(retryDelayMs);
      outcome = await sendOnce(body);
    }
    return outcome;
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * Send what is queued when this flush starts. A rejected batch is dropped
   * and the rest of the flush still goes out; a batch that never reached
   * PostHog goes back to the front of the queue for the next flush. Either
   * way the flush logs the failure.
   */
  const drain = async (): Promise<DeliveryFailure | null> => {
    clearTimer();
    let remaining = queue.length;
    let rejected: DeliveryFailure | null = null;
    while (remaining > 0 && queue.length > 0) {
      const batch = queue.slice(0, Math.min(maxBatchSize, remaining));
      queue = queue.slice(batch.length);
      const outcome = await send(batch);
      if (outcome.kind === "ok") {
        remaining -= batch.length;
        continue;
      }
      if (
        outcome.kind === "http_status" &&
        outcome.status === PAYLOAD_TOO_LARGE &&
        batch.length > 1
      ) {
        maxBatchSize = Math.max(1, Math.floor(batch.length / 2));
        queue = [...batch, ...queue];
        continue;
      }
      if (outcome.kind === "network") {
        queue = [...batch, ...queue].slice(0, maxQueueSize);
        return { reason: "unreached", errorType: outcome.errorType };
      }
      rejected ??= { reason: "rejected", status: outcome.status };
      remaining -= batch.length;
    }
    return rejected;
  };

  // observeFailure captures through this client, so the client sits below it
  // and logs its failures directly, as a warning: a captured failure would be
  // queued behind the batch that just failed.
  const drainAndReport = async (): Promise<void> => {
    const drained = await Result.tryPromise(drain);
    const failure: DeliveryFailure | null = Result.isError(drained)
      ? { reason: "drain_failed", errorType: errorTag(drained.error.cause) }
      : drained.value;
    if (failure === null) {
      return;
    }
    logger.warn("analytics.delivery.failed", {
      "analytics.delivery.failure": failure.reason,
      ...(failure.reason === "rejected"
        ? { "http.status_code": failure.status }
        : { "error.type": failure.errorType }),
    });
  };

  const requestDrain = createCoalescedDrain(drainAndReport);

  const flush = async (): Promise<void> => {
    await requestDrain().completion;
  };

  const enqueue = (message: Omit<PostHogMessage, "timestamp" | "uuid">) => {
    if (queue.length >= maxQueueSize) {
      queue.shift();
    }
    queue.push({
      ...message,
      timestamp: isoNow(),
      uuid: Bun.randomUUIDv7(),
    });
    if (queue.length >= flushAt) {
      requestDrain();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        requestDrain();
      }, flushIntervalMs);
      // A pending flush must not keep the process alive on its own.
      timer.unref();
    }
  };

  // Every event carries the library stamp, marks itself as server-side, and
  // opts out of GeoIP: the request IP PostHog sees is the API's, not a user's.
  const commonProperties = {
    $lib: LIBRARY_ID,
    $lib_version: APP_VERSION,
    $is_server: true,
    $geoip_disable: true,
  } as const;

  return {
    capture: ({ distinctId, event, groups, properties }) => {
      if (!ALLOWED_EVENTS.has(event)) {
        return;
      }
      // An event without an identity gets a fresh one and no person
      // profile, as the SDK did, instead of merging every such event into
      // one empty-id person.
      const anonymous = distinctId === "";
      enqueue({
        distinct_id: anonymous ? Bun.randomUUIDv7() : distinctId,
        event,
        properties: {
          ...properties,
          ...(anonymous ? { $process_person_profile: false } : {}),
          app_commit: APP_COMMIT_SHA,
          [RELEASE_VERSION_PROPERTY]: APP_VERSION,
          ...(deployEnvironment === undefined
            ? {}
            : { [RELEASE_ENVIRONMENT_PROPERTY]: deployEnvironment }),
          ...(groups === undefined ? {} : { $groups: groups }),
          ...commonProperties,
        },
      });
    },
    identifyOrganizationGroup: (params) => {
      enqueue({
        distinct_id: `$${POSTHOG_ORGANIZATION_GROUP_TYPE}_${params.organizationId}`,
        event: "$groupidentify",
        properties: {
          $group_type: POSTHOG_ORGANIZATION_GROUP_TYPE,
          $group_key: params.organizationId,
          $group_set: params.properties,
          ...commonProperties,
        },
      });
    },
    flush,
  };
};
