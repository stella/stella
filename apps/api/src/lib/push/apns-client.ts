import { Result, TaggedError } from "better-result";
import { connect, constants } from "node:http2";
import type { ClientHttp2Session } from "node:http2";

import type {
  ApnsEnvironment,
  MobileAppBundleId,
  MobilePushPayload,
} from "@stll/api-contract/mobile-push";
import { declareFingerprintFields } from "@stll/errors";
import { Temporal } from "@stll/time";

import type { ApnsProviderToken } from "@/api/lib/push/apns-provider-token";

/**
 * The two APNs gateways. A device's token belongs to exactly one, decided by
 * how the app was signed, and the registration says which.
 */
export const APNS_ORIGINS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const satisfies Record<ApnsEnvironment, string>;

/** One APNs request's deadline, connection setup included. */
const APNS_REQUEST_TIMEOUT_MS = 10_000;

/** An idle connection is closed after this long; the next send reopens it. */
const APNS_SESSION_IDLE_MS = 5 * 60_000;

/**
 * How long Apple keeps an alert for a device that is offline. A nudge that
 * arrives a day late is no longer worth showing.
 */
const APNS_ALERT_LIFETIME_SECONDS = 24 * 60 * 60;

export class ApnsTransportError extends TaggedError("ApnsTransportError")<{
  message: string;
  reason: "timeout" | "connection";
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export type ApnsHttpRequest = {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type ApnsHttpResponse = { status: number; body: string };

/** The wire under the client; tests hand in a fake gateway. */
export type ApnsTransport = {
  post: (
    request: ApnsHttpRequest,
  ) => Promise<Result<ApnsHttpResponse, ApnsTransportError>>;
  close: () => void;
};

/**
 * APNs speaks HTTP/2 only, which `fetch` does not negotiate here, so requests
 * go through `node:http2`: one long-lived connection per gateway, reopened
 * after it closes, fails or goes away.
 */
export const createHttp2ApnsTransport = ({
  timeoutMs = APNS_REQUEST_TIMEOUT_MS,
}: { timeoutMs?: number } = {}): ApnsTransport => {
  const sessions = new Map<string, ClientHttp2Session>();

  const forget = (origin: string, session: ClientHttp2Session) => {
    if (sessions.get(origin) === session) {
      sessions.delete(origin);
    }
  };

  const sessionFor = (origin: string): ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing !== undefined && !existing.closed && !existing.destroyed) {
      return existing;
    }
    const session = connect(origin);
    // A session error also fails its open streams, which report it; the
    // listener keeps an unhandled `error` event from ending the process.
    session.on("error", () => forget(origin, session));
    session.on("goaway", () => forget(origin, session));
    session.on("close", () => forget(origin, session));
    session.setTimeout(APNS_SESSION_IDLE_MS, () => session.close());
    sessions.set(origin, session);
    return session;
  };

  const post = async (
    request: ApnsHttpRequest,
  ): Promise<Result<ApnsHttpResponse, ApnsTransportError>> =>
    await new Promise((resolve) => {
      const stream = sessionFor(request.origin).request({
        ...request.headers,
        ":method": "POST",
        ":path": request.path,
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      let settled = false;
      const settle = (
        outcome: Result<ApnsHttpResponse, ApnsTransportError>,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve(outcome);
      };
      const deadline = setTimeout(() => {
        stream.close(constants.NGHTTP2_CANCEL);
        settle(
          Result.err(
            new ApnsTransportError({
              message: "APNs did not answer in time",
              reason: "timeout",
            }),
          ),
        );
      }, timeoutMs);
      stream.setEncoding("utf-8");
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => settle(Result.ok({ status, body })));
      stream.on("error", (cause) =>
        settle(
          Result.err(
            new ApnsTransportError({
              message: "The APNs request failed",
              reason: "connection",
              cause,
            }),
          ),
        ),
      );
      stream.end(request.body);
    });

  return {
    post,
    close: () => {
      for (const session of sessions.values()) {
        session.close();
      }
      sessions.clear();
    },
  };
};

/**
 * What one alert to one device came to.
 *
 * - `delivered`: Apple accepted it.
 * - `device_gone`: the token is dead or belongs to another app or gateway;
 *   the device is removed, and the app registers again when it next runs.
 * - `retry`: throttled, an Apple outage, an expired provider token, or the
 *   network; worth sending again later.
 * - `rejected`: the request itself is wrong (payload, credentials, topic);
 *   sending it again would be refused the same way.
 */
export type ApnsOutcome =
  | { type: "delivered" }
  | { type: "device_gone"; reason: string }
  | { type: "retry"; reason: string }
  | { type: "rejected"; reason: string; status: number };

const DEAD_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
]);

const readReason = (body: string): string => {
  const parsed = Result.try((): unknown => JSON.parse(body));
  if (Result.isError(parsed)) {
    return "";
  }
  const value: unknown = parsed.value;
  if (typeof value !== "object" || value === null || !("reason" in value)) {
    return "";
  }
  return typeof value.reason === "string" ? value.reason : "";
};

/** Apple's status and reason, as one of the outcomes above. */
export const classifyApnsResponse = ({
  status,
  body,
}: ApnsHttpResponse): ApnsOutcome => {
  if (status === 200) {
    return { type: "delivered" };
  }
  const reason = readReason(body) || `HTTP ${status}`;
  if (status === 410) {
    return { type: "device_gone", reason };
  }
  if (status === 400 && DEAD_TOKEN_REASONS.has(reason)) {
    return { type: "device_gone", reason };
  }
  if (status === 403 && reason === "ExpiredProviderToken") {
    return { type: "retry", reason };
  }
  if (status === 429 || status >= 500) {
    return { type: "retry", reason };
  }
  return { type: "rejected", reason, status };
};

/** One alert addressed to one registered device. */
export type ApnsAlert = {
  environment: ApnsEnvironment;
  token: string;
  bundleId: MobileAppBundleId;
  payload: MobilePushPayload;
  /** Identifies the alert on the device, so a resend replaces the first. */
  collapseId: string;
};

export type ApnsClient = {
  send: (alert: ApnsAlert) => Promise<ApnsOutcome>;
  close: () => void;
};

export const createApnsClient = ({
  transport,
  providerToken,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: {
  transport: ApnsTransport;
  providerToken: ApnsProviderToken;
  now?: () => number;
}): ApnsClient => ({
  send: async (alert) => {
    const token = await providerToken.current();
    if (Result.isError(token)) {
      return {
        type: "rejected",
        reason: "ProviderTokenUnavailable",
        status: 0,
      };
    }
    const response = await transport.post({
      origin: APNS_ORIGINS[alert.environment],
      path: `/3/device/${alert.token}`,
      headers: {
        authorization: `bearer ${token.value}`,
        "apns-topic": alert.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": alert.collapseId,
        "apns-expiration": String(
          Math.floor(now() / 1000) + APNS_ALERT_LIFETIME_SECONDS,
        ),
      },
      body: JSON.stringify(alert.payload),
    });
    if (Result.isError(response)) {
      return { type: "retry", reason: response.error.reason };
    }
    const outcome = classifyApnsResponse(response.value);
    if (outcome.type === "retry" && outcome.reason === "ExpiredProviderToken") {
      providerToken.expire();
    }
    return outcome;
  },
  close: () => transport.close(),
});
