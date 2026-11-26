import { describe, expect, jest, test } from "bun:test";

import { deferred } from "@stll/test-kit";

import { createRootRunStateSend } from "@/api/lib/workflow/root-run-state-store";

const COMMAND_TIMEOUT_MS = 20;

/**
 * The class this pins: run state is a lock and its bookkeeping, so a command
 * that outlived the caller it was bounded for must not be applied. Bounding
 * the wait alone does not do that — the connect keeps climbing after the
 * rejection, and a `tryClaim` sent then would hold a workspace for a request
 * that has already failed, a `clear` sent then would delete the state of
 * whichever run claimed it next.
 */
describe("the root run-state command path", () => {
  test("does not send a command whose connection arrived after the deadline", async () => {
    jest.useFakeTimers();
    try {
      const sent: string[] = [];
      const connectGate = deferred<undefined>();
      const send = createRootRunStateSend(async () => {
        await connectGate.promise;
        return {
          send: async (command: string) => {
            sent.push(command);
            return await Promise.resolve("OK");
          },
        };
      }, COMMAND_TIMEOUT_MS);

      const pending = send("DEL", ["key"]).then(
        () => null,
        (error: unknown) => error,
      );
      jest.advanceTimersByTime(COMMAND_TIMEOUT_MS);
      const rejection: unknown = await pending;
      // Release the late connect so the command has its chance to be sent.
      connectGate.resolve(undefined);
      for (let turn = 0; turn < 20; turn += 1) {
        await Promise.resolve();
      }

      expect(rejection).toMatchObject({ _tag: "TimeoutError" });
      expect(sent).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("sends a command that reached a live connection inside the bound", async () => {
    const sent: string[] = [];
    const send = createRootRunStateSend(
      async () =>
        await Promise.resolve({
          send: async (command: string) => {
            sent.push(command);
            return await Promise.resolve("OK");
          },
        }),
    );

    expect(await send("DEL", ["key"])).toBe("OK");
    expect(sent).toEqual(["DEL"]);
  });

  test("the store's own client cannot queue commands while disconnected", async () => {
    const source = await Bun.file(
      new URL("root-run-state-store.ts", import.meta.url),
    ).text();

    // A queued command is one that outlives its caller, which is exactly what
    // the bound above exists to prevent. The holder is what makes opting out
    // safe: `ready()` awaits the connection, so no caller here can issue a
    // command against a client that is still connecting.
    expect(source).toContain("enableOfflineQueue: false");
    expect(source.match(/createRedisClient\(/gu)).toHaveLength(1);
  });
});
