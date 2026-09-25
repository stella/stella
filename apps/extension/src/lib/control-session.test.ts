import { describe, expect, test } from "bun:test";

import { createControlSession } from "./control-session";

const deferred = () => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
};

describe("browser control session", () => {
  test("rejects overlap and releases the controller after completion", async () => {
    const session = createControlSession();
    const blocker = deferred();
    const first = session.runCommand(async () => {
      await blocker.promise;
      return "first";
    });

    expect(await session.runCommand(async () => "hidden late action")).toEqual({
      status: "busy",
    });
    blocker.resolve();
    expect(await first).toEqual({ result: "first", status: "completed" });
    expect(await session.runCommand(async () => "next")).toEqual({
      result: "next",
      status: "completed",
    });
  });

  test("a cancel aborts the running command's signal", async () => {
    const session = createControlSession();
    const started = deferred();
    const running = session.runCommand(
      async (signal) =>
        await new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("aborted"));
          started.resolve();
        }),
    );
    await started.promise;

    session.cancel();

    expect(await running).toEqual({ result: "aborted", status: "completed" });
  });

  test("a change waits for the running command and invalidates queued work", async () => {
    const session = createControlSession();
    const order: string[] = [];
    const blocker = deferred();
    const running = session.runCommand(async (signal) => {
      await blocker.promise;
      order.push(`command aborted=${signal.aborted}`);
    });
    const change = session.change(async () => {
      order.push("change");
    });
    blocker.resolve();
    await Promise.all([running, change]);

    expect(order).toEqual(["command aborted=true", "change"]);
  });

  test("a command admitted before a change never starts un-aborted", async () => {
    const session = createControlSession();
    const blocker = deferred();
    const pairing = session.change(async () => {
      await blocker.promise;
    });
    const queued = session.runCommand(async (signal) => signal.aborted);
    // A pairing change during the command's wait: the command was admitted
    // under the pairing that the change replaces.
    const replacement = session.change(async () => undefined);
    blocker.resolve();
    await Promise.all([pairing, replacement]);

    expect(await queued).toEqual({ result: true, status: "completed" });
    expect(await session.runCommand(async (signal) => signal.aborted)).toEqual({
      result: false,
      status: "completed",
    });
  });

  test("a failed change does not wedge later commands", async () => {
    const session = createControlSession();
    const failed = session.change(async () => {
      await Promise.reject(new Error("storage unavailable"));
    });
    const failure = await failed.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toHaveProperty("message", "storage unavailable");

    expect(await session.runCommand(async () => "ran")).toEqual({
      result: "ran",
      status: "completed",
    });
  });
});
