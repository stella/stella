import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createContinuationStore } from "@/api/lib/legal-search/public-read-continuation-store";

const recordingSender = (reply: unknown) => {
  const commands: { command: string; args: string[] }[] = [];
  return {
    commands,
    ready: async () => ({
      send: async (command: string, args: string[]) => {
        commands.push({ command, args });
        return reply;
      },
    }),
  };
};

describe("public-read continuation store", () => {
  test("every key shares one slot per work, so a script may touch them together", async () => {
    const { commands, ready } = recordingSender("OK");
    const store = createContinuationStore({ ready });
    await store.writeSpec("w1", "{}", 1000);
    await store.writeFinished("w1", "{}", 1000);
    await store.acquireLease("w1", "owner", 1000);
    for (const { args } of commands) {
      expect(args.at(0)).toContain("public-read-continuation:{w1}:");
    }
  });

  test("a lease is taken only if absent, and with an expiry", async () => {
    const { commands, ready } = recordingSender("OK");
    const store = createContinuationStore({ ready });
    expect(Result.unwrap(await store.acquireLease("w1", "owner", 1500))).toBe(
      true,
    );
    const lease = commands.at(0);
    expect(lease?.command).toBe("SET");
    expect(lease?.args).toEqual([
      "public-read-continuation:{w1}:lease",
      "owner",
      "PX",
      "1500",
      "NX",
    ]);
  });

  test("a lease held by someone else reads as not acquired", async () => {
    const { ready } = recordingSender(null);
    const store = createContinuationStore({ ready });
    expect(Result.unwrap(await store.acquireLease("w1", "owner", 1000))).toBe(
      false,
    );
  });

  test("a failed command opens the breaker, so the next one makes no connection", async () => {
    let connects = 0;
    let clock = 0;
    const store = createContinuationStore({
      now: () => clock,
      ready: async () => {
        connects += 1;
        throw new Error("connection refused");
      },
    });
    expect(Result.isError(await store.readSpec("w1"))).toBe(true);
    expect(connects).toBe(1);
    expect(Result.isError(await store.readFinished("w1"))).toBe(true);
    expect(connects).toBe(1);
    clock += 6000;
    expect(Result.isError(await store.readFinished("w1"))).toBe(true);
    expect(connects).toBe(2);
  });
});
