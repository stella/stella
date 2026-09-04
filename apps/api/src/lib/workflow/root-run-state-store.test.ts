import { describe, expect, test } from "bun:test";

import { createRootRunStateSend } from "@/api/lib/workflow/root-run-state-store";

const COMMAND_TIMEOUT_MS = 20;
// Long enough that the bound above is reached first, short enough to keep the
// test quick.
const LATE_CONNECT_MS = 200;

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
    const sent: string[] = [];
    const send = createRootRunStateSend(async () => {
      await Bun.sleep(LATE_CONNECT_MS);
      return {
        send: async (command: string) => {
          sent.push(command);
          return await Promise.resolve("OK");
        },
      };
    }, COMMAND_TIMEOUT_MS);

    const rejection: unknown = await send("DEL", ["key"]).then(
      () => null,
      (error: unknown) => error,
    );
    // Past the connect, so the command has had its chance to be sent.
    await Bun.sleep(LATE_CONNECT_MS);

    expect(rejection).toMatchObject({ _tag: "TimeoutError" });
    expect(sent).toEqual([]);
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
