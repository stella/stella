import { describe, expect, test } from "bun:test";

import { withReservedSession } from "./case-law-provision-state-backfill";

/** A reserved connection that records what happens to it, in order. */
const fakeConnection = ({
  events,
  pidQuery = async () => [{ pid: 42 }],
  onQuery = async () => [],
}: {
  events: string[];
  pidQuery?: () => Promise<unknown>;
  onQuery?: (query: string) => Promise<unknown>;
}) => ({
  unsafe: async (query: string) => {
    events.push(`query ${query}`);
    return query.includes("pg_backend_pid")
      ? await pidQuery()
      : await onQuery(query);
  },
  release: () => {
    events.push("release");
  },
  close: async () => {
    events.push("close");
  },
});

describe("withReservedSession", () => {
  test("returns the connection to the pool after an ordinary run", async () => {
    const events: string[] = [];
    const result = await withReservedSession({
      reserve: async () => fakeConnection({ events }),
      cancelBackend: async () => {
        events.push("cancel");
      },
      signal: new AbortController().signal,
      work: async (session) => {
        await session.execute("SELECT 1");
        return "done";
      },
    });
    expect(result).toBe("done");
    expect(events).toEqual([
      "query SELECT pg_backend_pid() AS pid",
      "query SELECT 1",
      "release",
    ]);
  });

  test("releases the connection when reading its backend pid fails", async () => {
    const events: string[] = [];
    const run = withReservedSession({
      reserve: async () =>
        fakeConnection({
          events,
          pidQuery: async () => {
            throw new Error("connection lost");
          },
        }),
      cancelBackend: async () => undefined,
      signal: new AbortController().signal,
      work: async () => "unreached",
    });
    expect(
      await run.then(
        () => "resolved",
        (error: unknown) => error,
      ),
    ).toEqual(new Error("connection lost"));
    expect(events.at(-1)).toBe("release");
  });

  /**
   * An abort cancels the statement in flight from another connection. That
   * cancel may arrive after the statement ends, so the connection is closed,
   * not pooled, and only once the cancel has settled.
   */
  test("closes an aborted connection after its cancel settles", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const cancelSent = Promise.withResolvers<undefined>();
    const statement = Promise.withResolvers<unknown>();
    const run = withReservedSession({
      reserve: async () =>
        fakeConnection({
          events,
          onQuery: async () => await statement.promise,
        }),
      cancelBackend: async (pid) => {
        events.push(`cancel ${String(pid)}`);
        await cancelSent.promise;
        events.push("cancel settled");
      },
      signal: controller.signal,
      work: async (session) => {
        const pending = session.query("SELECT pg_sleep(60)");
        controller.abort();
        statement.resolve([]);
        await pending;
        return "stopped";
      },
    });
    // The statement has finished; the cancel is still on its way.
    await Bun.sleep(10);
    expect(events).not.toContain("close");
    expect(events).not.toContain("release");
    cancelSent.resolve(undefined);
    expect(await run).toBe("stopped");
    expect(events.slice(-3)).toEqual(["cancel 42", "cancel settled", "close"]);
    expect(events).not.toContain("release");
  });
});
