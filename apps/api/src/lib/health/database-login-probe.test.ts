import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import type { FreshLoginClient } from "@/api/lib/health/database-login-probe";
import {
  attemptFreshLogin,
  DATABASE_LOGIN_ATTEMPT_DEADLINE_MS,
  DATABASE_LOGIN_PROBE_INTERVAL_MS,
  openFreshLoginClient,
  startDatabaseLoginProbe,
} from "@/api/lib/health/database-login-probe";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const SINK_EVENT = "db.fresh_login";

// What Bun's driver rejects with when the server refuses the password.
const authRejected = (): Error =>
  new SQL.PostgresError('password authentication failed for user "app"', {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "28P01",
    detail: "",
    hint: "",
    severity: "FATAL",
  });

// What a query still in flight rejects with once its client is closed.
const connectionClosed = (): Error =>
  new SQL.PostgresError("Connection closed", {
    code: "ERR_POSTGRES_CONNECTION_CLOSED",
    detail: "",
    hint: "",
    severity: "",
  });

type FakeConnection = {
  readonly openClient: () => FreshLoginClient;
  readonly opened: () => number;
  readonly closed: () => number;
};

type FakeConnectionOptions = {
  /** How each query settles; a query that never settles by default. */
  readonly query?: () => Promise<unknown>;
  readonly close?: () => Promise<void>;
};

/**
 * Clients that behave like the driver's: a query still pending when its
 * client closes rejects with a closed connection.
 */
const fakeConnection = ({
  query,
  close = async () => undefined,
}: FakeConnectionOptions = {}): FakeConnection => {
  let opened = 0;
  let closed = 0;
  return {
    openClient: () => {
      opened += 1;
      const pending = Promise.withResolvers<unknown>();
      // Handled here too, for clients whose query never awaited it.
      pending.promise.catch(() => undefined);
      return {
        selectOne: query ?? (async () => await pending.promise),
        close: async () => {
          closed += 1;
          pending.reject(connectionClosed());
          await close();
        },
      };
    },
    opened: () => opened,
    closed: () => closed,
  };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
};

const sinkRecords = (logs: RecordingLogger) =>
  logs.records.filter((record) => record.message === SINK_EVENT);

let logs: RecordingLogger;
let analytics: RecordingAnalytics;

beforeEach(() => {
  logs = installRecordingLogger();
  analytics = installRecordingAnalytics();
});

afterEach(() => {
  jest.useRealTimers();
  logs.restore();
  analytics.restore();
});

describe("a single database login check", () => {
  test("closes its client after a successful query and reports nothing", async () => {
    const connection = fakeConnection({
      query: async () => [{ "?column?": 1 }],
    });

    await attemptFreshLogin({
      openClient: connection.openClient,
      signal: new AbortController().signal,
    });

    expect(connection.closed()).toBe(1);
    expect(sinkRecords(logs)).toEqual([]);
  });

  test("reports a refused login as an error with its reason, and closes the client", async () => {
    const connection = fakeConnection({
      query: async () => await Promise.reject(authRejected()),
    });

    await attemptFreshLogin({
      openClient: connection.openClient,
      signal: new AbortController().signal,
    });

    expect(connection.closed()).toBe(1);
    const [record, ...rest] = sinkRecords(logs);
    expect(rest).toEqual([]);
    expect(record?.severityText).toBe("ERROR");
    expect(record?.attributes).toMatchObject({
      "failure.grade": "defect",
      "failure.reason": "pg_auth_failed",
      "failure.sink": SINK_EVENT,
      "failure.policy": "grade",
      "error.sqlstate": "28P01",
    });
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("closes a client whose query outlives the deadline and warns", async () => {
    jest.useFakeTimers();
    const connection = fakeConnection();

    const attempt = attemptFreshLogin({
      openClient: connection.openClient,
      signal: new AbortController().signal,
    });
    jest.advanceTimersByTime(DATABASE_LOGIN_ATTEMPT_DEADLINE_MS - 1);
    await flushMicrotasks();
    expect(connection.closed()).toBe(0);

    jest.advanceTimersByTime(1);
    await attempt;

    expect(connection.closed()).toBe(1);
    const [record, ...rest] = sinkRecords(logs);
    expect(rest).toEqual([]);
    expect(record?.severityText).toBe("WARN");
    expect(record?.attributes).toMatchObject({
      "failure.grade": "transient",
      "failure.reason": "network_timeout",
    });
    expect(analytics.exceptions()).toEqual([]);
  });

  test("keeps the query's failure when closing the client fails too", async () => {
    const connection = fakeConnection({
      query: async () => await Promise.reject(authRejected()),
      close: async () => {
        await Promise.reject(new Error("close failed"));
      },
    });

    await attemptFreshLogin({
      openClient: connection.openClient,
      signal: new AbortController().signal,
    });

    expect(sinkRecords(logs).map((record) => record.attributes)).toEqual([
      expect.objectContaining({ "failure.reason": "pg_auth_failed" }),
    ]);
  });
});

describe("the periodic database login check", () => {
  test("waits its random offset before the first check", async () => {
    jest.useFakeTimers();
    const connection = fakeConnection({ query: async () => [] });
    const offsetMs = DATABASE_LOGIN_PROBE_INTERVAL_MS / 2;

    const close = startDatabaseLoginProbe({
      openClient: connection.openClient,
      random: () => 0.5,
    });
    jest.advanceTimersByTime(offsetMs - 1);
    expect(connection.opened()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(connection.opened()).toBe(1);

    await flushMicrotasks();
    jest.advanceTimersByTime(DATABASE_LOGIN_PROBE_INTERVAL_MS);
    expect(connection.opened()).toBe(2);
    await close();
  });

  test("starts no check while the previous one is still closing", async () => {
    jest.useFakeTimers();
    const closing = Promise.withResolvers<undefined>();
    const connection = fakeConnection({
      query: async () => [],
      close: async () => await closing.promise,
    });

    const close = startDatabaseLoginProbe({
      openClient: connection.openClient,
      random: () => 0,
    });
    await flushMicrotasks();
    jest.advanceTimersByTime(DATABASE_LOGIN_PROBE_INTERVAL_MS * 3);
    expect(connection.opened()).toBe(1);

    closing.resolve(undefined);
    await flushMicrotasks();
    jest.advanceTimersByTime(DATABASE_LOGIN_PROBE_INTERVAL_MS);
    expect(connection.opened()).toBe(2);
    await close();
  });

  test("closing ends the check in flight silently and starts no more", async () => {
    jest.useFakeTimers();
    const connection = fakeConnection();

    const close = startDatabaseLoginProbe({
      openClient: connection.openClient,
      random: () => 0,
    });
    expect(connection.opened()).toBe(1);

    await close();

    expect(connection.closed()).toBe(1);
    jest.advanceTimersByTime(DATABASE_LOGIN_PROBE_INTERVAL_MS * 3);
    expect(connection.opened()).toBe(1);
    expect(sinkRecords(logs)).toEqual([]);
  });

  test("closing before the first check cancels it", async () => {
    jest.useFakeTimers();
    const connection = fakeConnection({ query: async () => [] });

    const close = startDatabaseLoginProbe({
      openClient: connection.openClient,
      random: () => 0.5,
    });
    expect(jest.getTimerCount()).toBe(1);
    await close();

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(DATABASE_LOGIN_PROBE_INTERVAL_MS * 3);
    expect(connection.opened()).toBe(0);
  });
});

const SSL_REQUEST_CODE = 80_877_103;

const backendMessage = (type: string, body: Uint8Array): Uint8Array => {
  const message = new Uint8Array(5 + body.length);
  const view = new DataView(message.buffer);
  message[0] = type.codePointAt(0) ?? 0;
  view.setInt32(1, 4 + body.length);
  message.set(body, 5);
  return message;
};

/**
 * A server that completes the startup handshake without a password and then
 * never answers a query: a session that stalls after the login succeeded.
 */
const stallingServer = () => {
  const queryReceived = Promise.withResolvers<undefined>();
  let started = false;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: (socket, data) => {
        const view = new DataView(data.buffer, data.byteOffset, data.length);
        if (data.length === 8 && view.getInt32(4) === SSL_REQUEST_CODE) {
          socket.write("N");
          return;
        }
        if (!started) {
          started = true;
          socket.write(backendMessage("R", new Uint8Array(4)));
          socket.write(backendMessage("Z", new TextEncoder().encode("I")));
          return;
        }
        queryReceived.resolve(undefined);
      },
    },
  });
  return { server, queryReceived: queryReceived.promise };
};

describe("the dedicated login client", () => {
  test("closing it ends a query the server never answers", async () => {
    const { server, queryReceived } = stallingServer();
    try {
      const client = openFreshLoginClient(
        `postgres://app:unused@127.0.0.1:${String(server.port)}/app`,
      );
      const query = client.selectOne().then(
        () => "answered",
        (error: unknown) => error,
      );
      await queryReceived;

      const closing = performance.now();
      await client.close();
      const outcome = await query;

      expect(performance.now() - closing).toBeLessThan(1000);
      expect(outcome).toMatchObject({ code: "ERR_POSTGRES_CONNECTION_CLOSED" });
    } finally {
      server.stop(true);
    }
  });
});
