import { describe, expect, test } from "bun:test";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import {
  nonEvictingRedis,
  type StorePolicyObservation,
} from "@/api/lib/non-evicting-redis";

const fixture = (initialInfo: unknown) => {
  let info = initialInfo;
  let infoCalls = 0;
  let commands = 0;
  let refresh = () => {};
  let cancelled = false;
  const observations: StorePolicyObservation[] = [];
  const client = {
    send: async (command: string) => {
      if (command === "INFO") {
        infoCalls += 1;
        if (info instanceof Error) {
          throw info;
        }
        return info;
      }
      commands += 1;
      return "OK";
    },
  };
  const store = nonEvictingRedis({
    connection: { ready: async () => client, close: () => {} },
    observe: (observation) => observations.push(observation),
    scheduleRefresh: (callback) => {
      refresh = callback;
      return () => {
        cancelled = true;
      };
    },
  });
  return {
    client,
    store,
    observations,
    stats: () => ({ infoCalls, commands, cancelled }),
    change: (reply: unknown) => {
      info = reply;
    },
    refresh: () => refresh(),
  };
};

describe("non-evicting admission coordination", () => {
  for (const lineEnding of ["\n", "\r\n"]) {
    test(`noeviction allows commands and shares the check (${JSON.stringify(lineEnding)})`, async () => {
      const f = fixture(
        `# Memory${lineEnding}maxmemory_policy:noeviction${lineEnding}`,
      );
      const clients = await Promise.all([f.store.ready(), f.store.ready()]);
      for (const client of clients) {
        expect(await client.send("EVAL", [])).toBe("OK");
      }
      expect(f.stats()).toMatchObject({ infoCalls: 1, commands: 2 });
      expect(f.observations).toEqual([{ status: "allowed" }]);
      f.store.close();
      expect(f.stats().cancelled).toBe(true);
    });
  }

  test("an evicting policy refuses admission without blocking cache commands", async () => {
    const f = fixture("maxmemory_policy:allkeys-lru\r\n");
    const client = await f.store.ready();
    await expect(client.send("EVAL", [])).rejects.toMatchObject({
      _tag: "ActionAdmissionError",
      reason: "unavailable",
      message: expect.stringContaining("maxmemory-policy noeviction"),
    });
    expect(f.stats().commands).toBe(0);
    expect(f.observations).toEqual([{ status: "refused" }]);
    expect(await f.client.send("GET")).toBe("OK");
    f.store.close();
  });

  for (const reply of [
    "# Memory\r\nused_memory:1\r\n",
    "maxmemory_policy:\r\n",
    null,
    new TypeError("INFO denied"),
  ]) {
    test(`an uninspectable policy warns and allows commands (${String(reply)})`, async () => {
      const f = fixture(reply);
      const client = await f.store.ready();
      expect(await client.send("EVAL", [])).toBe("OK");
      expect(f.observations).toEqual([{ status: "unknown" }]);
      f.store.close();
    });
  }

  test("refresh refuses existing clients, recovers, and stops on close", async () => {
    const f = fixture("maxmemory_policy:noeviction\n");
    const client = await f.store.ready();
    for (const policy of ["allkeys-lru", "noeviction", "volatile-lru"]) {
      f.change(`maxmemory_policy:${policy}\n`);
      f.refresh();
      await f.store.ready();
      if (policy === "noeviction") {
        expect(await client.send("EVAL", [])).toBe("OK");
      } else {
        await expect(client.send("EVAL", [])).rejects.toBeInstanceOf(
          ActionAdmissionError,
        );
      }
    }
    expect(f.stats().infoCalls).toBe(4);
    f.store.close();
    f.refresh();
    expect(f.stats().infoCalls).toBe(4);
  });

  test("replacement connections are checked independently", async () => {
    const good = fixture("maxmemory_policy:noeviction\n");
    const bad = fixture("maxmemory_policy:allkeys-lru\n");
    let client = good.client;
    let refresh = () => {};
    const store = nonEvictingRedis({
      connection: { ready: async () => client, close: () => {} },
      observe: () => {},
      scheduleRefresh: (callback) => {
        refresh = callback;
        return () => {};
      },
    });
    expect(await (await store.ready()).send("EVAL", [])).toBe("OK");
    client = bad.client;
    const replacement = await store.ready();
    await expect(replacement.send("EVAL", [])).rejects.toBeInstanceOf(
      ActionAdmissionError,
    );
    bad.change("maxmemory_policy:noeviction\n");
    refresh();
    await store.ready();
    expect(await replacement.send("EVAL", [])).toBe("OK");
    expect(good.stats().infoCalls).toBe(1);
    expect(bad.stats().infoCalls).toBe(2);
    store.close();
  });

  test("pending refresh coalesces and holds existing commands until inspection completes", async () => {
    const f = fixture("maxmemory_policy:noeviction\n");
    const client = await f.store.ready();
    const pending = Promise.withResolvers<string>();
    f.change(pending.promise);
    f.refresh();
    f.refresh();
    const command = client.send("EVAL", []);
    const readiness = f.store.ready();
    expect(f.stats()).toMatchObject({ infoCalls: 2, commands: 0 });
    pending.resolve("maxmemory_policy:allkeys-lru\n");
    await readiness;
    await expect(command).rejects.toBeInstanceOf(ActionAdmissionError);
    expect(f.stats()).toMatchObject({ infoCalls: 2, commands: 0 });
    f.store.close();
  });

  test("INFO timeout warns without blocking admission", async () => {
    const f = fixture(new Promise<never>(() => {}));
    const client = await f.store.ready();
    expect(await client.send("EVAL", [])).toBe("OK");
    expect(f.observations).toEqual([{ status: "unknown" }]);
    f.store.close();
  });

  test("an uninspectable refresh follows the documented unknown-policy behavior", async () => {
    const f = fixture("maxmemory_policy:allkeys-lru\n");
    const client = await f.store.ready();
    f.change(new TypeError("INFO denied"));
    f.refresh();
    expect(await client.send("EVAL", [])).toBe("OK");
    expect(f.observations).toEqual([
      { status: "refused" },
      { status: "unknown" },
    ]);
    f.store.close();
  });

  test("close abandons pending inspection and refuses old facades", async () => {
    const f = fixture("maxmemory_policy:noeviction\n");
    const client = await f.store.ready();
    const pending = Promise.withResolvers<string>();
    f.change(pending.promise);
    f.refresh();
    const waiting = f.store.ready();
    // Let readiness obtain its connection before it is closed.
    await Promise.resolve();
    f.store.close();
    pending.resolve("maxmemory_policy:noeviction\n");
    await expect(waiting).rejects.toMatchObject({
      _tag: "RedisClientClosedError",
    });
    await expect(client.send("EVAL", [])).rejects.toMatchObject({
      _tag: "RedisClientClosedError",
    });
    expect(f.stats().commands).toBe(0);
  });

  test("same-client reconnect inspects the new server before commands resume", async () => {
    const f = fixture("maxmemory_policy:noeviction\n");
    let reconnect = () => {};
    let disposed = false;
    const client = {
      ...f.client,
      onReconnect: (callback: () => void) => {
        reconnect = callback;
        return () => {
          disposed = true;
        };
      },
    };
    const store = nonEvictingRedis({
      connection: { ready: async () => client, close: () => {} },
      observe: () => {},
      scheduleRefresh: () => () => {},
    });
    const facade = await store.ready();
    f.change("maxmemory_policy:allkeys-lru\n");
    reconnect();
    await expect(facade.send("EVAL", [])).rejects.toBeInstanceOf(
      ActionAdmissionError,
    );
    expect(f.stats()).toMatchObject({ infoCalls: 2, commands: 0 });
    store.close();
    expect(disposed).toBe(true);
  });
});
