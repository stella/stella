import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createDesktopConnectionStore } from "@/features/desktop/desktop-connection-store.logic";
import type { DesktopLinkOutcome } from "@/features/desktop/desktop-connection-store.logic";

const scriptedStore = () => {
  const linked = Promise.withResolvers<Result<DesktopLinkOutcome, unknown>>();
  const calls: number[] = [];
  const errors: unknown[] = [];
  const store = createDesktopConnectionStore({
    link: async () => {
      calls.push(calls.length);
      return await linked.promise;
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { linked, calls, errors, store };
};

describe("desktop account connection", () => {
  test("reading and subscribing never starts a link", () => {
    const { store, calls } = scriptedStore();
    const release = store.subscribe(() => {});
    expect(store.getState()).toEqual({ status: "idle" });
    expect(store.getServerState()).toEqual({ status: "idle" });
    release();
    expect(calls).toEqual([]);
  });

  test("concurrent explicit connections join one attempt", async () => {
    const { store, calls, linked } = scriptedStore();
    const first = store.connect();
    const second = store.connect();
    expect(store.getState()).toEqual({ status: "connecting" });
    linked.resolve(
      Result.ok({ status: "connected", email: "lawyer@example.com" }),
    );
    expect(await first).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
    expect(await second).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
    expect(calls).toEqual([0]);
    expect(store.getState()).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
  });

  test("a failed connection reports the error and allows an explicit retry", async () => {
    const { store, calls, errors, linked } = scriptedStore();
    const failure = new Error("connection refused");
    const attempt = store.connect();
    linked.resolve(Result.err(failure));
    expect(await attempt).toEqual({ status: "error" });
    expect(store.getState()).toEqual({ status: "error" });
    expect(errors).toEqual([failure]);
    expect(await store.connect()).toEqual({ status: "error" });
    expect(calls).toEqual([0, 1]);
  });

  test("a thrown failure is reported without escaping into the UI", async () => {
    const failure = new Error("connection failed");
    const errors: unknown[] = [];
    const store = createDesktopConnectionStore({
      link: async () => {
        throw failure;
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    expect(await store.connect()).toEqual({ status: "error" });
    expect(errors).toEqual([failure]);
    expect(store.getState()).toEqual({ status: "error" });
  });

  test("an update-required refusal is retained without reporting a connection error", async () => {
    const { store, calls, errors, linked } = scriptedStore();
    const states: string[] = [];
    const release = store.subscribe(() => {
      states.push(store.getState().status);
    });
    const attempt = store.connect();
    linked.resolve(Result.ok({ status: "update-required" }));
    expect(await attempt).toEqual({ status: "update-required" });
    expect(store.getState()).toEqual({ status: "update-required" });
    expect(states).toEqual(["connecting", "update-required"]);
    expect(errors).toEqual([]);
    expect(calls).toEqual([0]);
    release();
  });

  test("starting the browser step does not report a connected account", async () => {
    const errors: unknown[] = [];
    const store = createDesktopConnectionStore({
      link: async () => Result.ok({ status: "started" }),
      onError: (error) => {
        errors.push(error);
      },
    });
    expect(await store.connect()).toEqual({ status: "started" });
    expect(store.getState()).toEqual({ status: "idle" });
    expect(errors).toEqual([]);
  });
});
