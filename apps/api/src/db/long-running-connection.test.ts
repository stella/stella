import { expect, test } from "bun:test";

import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

import {
  withDedicatedReservedSession,
  withLongRunningConnection,
} from "./long-running-connection";

test("dedicated connection rejects invalid budgets before opening", async () => {
  const signal = new AbortController().signal;
  for (const invalid of [0, -1, Number.NaN, Infinity, 1.5]) {
    expect(
      await withLongRunningConnection(
        { lockTimeout: 1, statementTimeout: invalid, signal },
        async () => "opened",
      ).then(
        () => "accepted",
        () => "rejected",
      ),
    ).toBe("rejected");
  }
});

test("abort waits for backend cancellation before closing the session", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const query = Promise.withResolvers<unknown>();
  const cancellation = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const workSettled = Promise.withResolvers<undefined>();
  const run = withDedicatedReservedSession({
    reserve: async () => ({
      unsafe: async (statement: string) => {
        if (statement.includes("pg_backend_pid")) {
          return [{ pid: 42 }];
        }
        events.push("query started");
        started.resolve(undefined);
        return await query.promise;
      },
      release: () => {
        events.push("release");
      },
      close: async () => {
        events.push("close");
      },
    }),
    cancelBackend: async (pid) => {
      events.push(`cancel ${pid}`);
      await cancellation.promise;
      events.push("cancel settled");
    },
    signal: controller.signal,
    work: async (connection) => {
      await connection.unsafe("SELECT pg_sleep(60)");
      workSettled.resolve(undefined);
      return "done";
    },
  });
  await started.promise;
  controller.abort();
  query.resolve([]);
  await workSettled.promise;
  expect(events).not.toContain("close");
  cancellation.resolve(undefined);
  expect(await run).toBe("done");
  expect(events).toEqual([
    "query started",
    "cancel 42",
    "cancel settled",
    "close",
  ]);
});

test("abort between statements refuses the next statement", async () => {
  const controller = new AbortController();
  const statements: string[] = [];
  const run = withDedicatedReservedSession({
    reserve: async () => ({
      unsafe: async (statement: string) => {
        statements.push(statement);
        return statement.includes("pg_backend_pid") ? [{ pid: 42 }] : [];
      },
      release: () => {},
      close: async () => {},
    }),
    cancelBackend: async () => {},
    signal: controller.signal,
    work: async (session) => {
      await session.unsafe("SELECT 1");
      controller.abort(new Error("session aborted between statements"));
      await session.unsafe("SELECT pg_sleep(60)");
    },
  });

  await expect(run).rejects.toThrow("session aborted between statements");
  expect(statements).toEqual(["SELECT pg_backend_pid() AS pid", "SELECT 1"]);
});

test("failed backend cancellation is reported before the session closes", async () => {
  const controller = new AbortController();
  const logs = installRecordingLogger();
  const events: string[] = [];
  const failure = new TypeError("cancellation connection failed");
  try {
    const run = withDedicatedReservedSession({
      reserve: async () => ({
        unsafe: async () => [{ pid: 42 }],
        release: () => events.push("release"),
        close: async () => {
          expect(
            logs.records.some(
              (record) => record.message === "db.long_running.cancel_failed",
            ),
          ).toBe(true);
          events.push("close");
        },
      }),
      cancelBackend: async () => {
        events.push("cancel");
        throw failure;
      },
      signal: controller.signal,
      work: async () => {
        controller.abort();
      },
    });

    await run;
    expect(events).toEqual(["cancel", "close"]);
    expect(logs.at("ERROR")).toContainEqual(
      expect.objectContaining({
        message: "db.long_running.cancel_failed",
        attributes: expect.objectContaining({ "error.type": "TypeError" }),
      }),
    );
  } finally {
    logs.restore();
  }
});
