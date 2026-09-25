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
    const first = session.runCommand("turn-1", async () => {
      await blocker.promise;
      return "first";
    });

    expect(
      await session.runCommand("turn-1", async () => "hidden late action"),
    ).toEqual({ status: "busy" });
    blocker.resolve();
    expect(await first).toEqual({ result: "first", status: "completed" });
    expect(await session.runCommand("turn-1", async () => "next")).toEqual({
      result: "next",
      status: "completed",
    });
  });

  test("a stop aborts the running command of its turn", async () => {
    const session = createControlSession();
    const started = deferred();
    const running = session.runCommand(
      "turn-1",
      async (signal) =>
        await new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("aborted"));
          started.resolve();
        }),
    );
    await started.promise;

    session.stopTurn("turn-1")();

    expect(await running).toEqual({ result: "aborted", status: "completed" });
  });

  test("a stop never reaches a command of another turn", async () => {
    const session = createControlSession();
    const blocker = deferred();
    const running = session.runCommand("turn-2", async (signal) => {
      await blocker.promise;
      return signal.aborted;
    });

    session.stopTurn("turn-1")();
    blocker.resolve();

    expect(await running).toEqual({ result: false, status: "completed" });
  });

  test("a stop verified late does not abort a command admitted after it arrived", async () => {
    const session = createControlSession();
    const oldCommand = session.runCommand("turn-1", async () => "done");
    // The stop arrives while the old command runs; verifying its sender
    // takes a storage read, during which the old command finishes and the
    // next one is admitted.
    const stopOldTurn = session.stopTurn("turn-1");
    await oldCommand;
    const blocker = deferred();
    const newCommand = session.runCommand("turn-1", async (signal) => {
      await blocker.promise;
      return signal.aborted;
    });

    stopOldTurn();
    blocker.resolve();

    expect(await newCommand).toEqual({ result: false, status: "completed" });
  });

  test("a change waits for the running command and aborts it first", async () => {
    const session = createControlSession();
    const order: string[] = [];
    const blocker = deferred();
    const running = session.runCommand("turn-1", async (signal) => {
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

  test("a command admitted behind a change starts aborted when a later change arrives", async () => {
    const session = createControlSession();
    const blocker = deferred();
    const pairing = session.change(async () => {
      await blocker.promise;
    });
    const queued = session.runCommand(
      "turn-1",
      async (signal) => signal.aborted,
    );
    // A pairing change during the command's wait: the command was admitted
    // under the pairing that the change replaces.
    const replacement = session.change(async () => undefined);
    blocker.resolve();
    await Promise.all([pairing, replacement]);

    expect(await queued).toEqual({ result: true, status: "completed" });
    expect(
      await session.runCommand("turn-1", async (signal) => signal.aborted),
    ).toEqual({ result: false, status: "completed" });
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

    expect(await session.runCommand("turn-1", async () => "ran")).toEqual({
      result: "ran",
      status: "completed",
    });
  });
});
