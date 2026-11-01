import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createDesktopConnectionStore } from "@/features/desktop/desktop-connection-store.logic";
import type {
  DesktopLinkApproval,
  DesktopLinkOutcome,
} from "@/features/desktop/desktop-connection-store.logic";

const scriptedStore = () => {
  const linked = Promise.withResolvers<Result<DesktopLinkOutcome, unknown>>();
  const calls: DesktopLinkApproval[] = [];
  const openers: ((desktopUrl: string) => void)[] = [];
  const errors: unknown[] = [];
  const store = createDesktopConnectionStore({
    link: async ({ approval, onDesktopOpening }) => {
      calls.push(approval);
      openers.push(onDesktopOpening);
      return await linked.promise;
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { linked, calls, errors, openers, store };
};

const DESKTOP_URL = "stella://account/complete?correlationId=fixture";

describe("desktop account connection", () => {
  test("reading and subscribing never starts a link", () => {
    const { store, calls } = scriptedStore();
    const release = store.subscribe(() => {});
    expect(store.getState()).toEqual({ status: "idle" });
    expect(store.getServerState()).toEqual({ status: "idle" });
    release();
    expect(calls).toEqual([]);
  });

  test("concurrent connections join one attempt", async () => {
    const { store, calls, linked } = scriptedStore();
    const first = store.connect("local-proof");
    const second = store.connect("explicit");
    expect(store.getState()).toEqual({
      status: "connecting",
      approval: "local-proof",
    });
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
    expect(calls).toEqual(["local-proof"]);
    expect(store.getState()).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
  });

  test("an opened app is offered again until the attempt settles", async () => {
    const { store, linked, openers } = scriptedStore();
    const attempt = store.connect("local-proof");
    openers.at(0)?.(DESKTOP_URL);
    expect(store.getState()).toEqual({
      status: "opening",
      desktopUrl: DESKTOP_URL,
    });
    linked.resolve(
      Result.ok({ status: "connected", email: "lawyer@example.com" }),
    );
    await attempt;
    // A late report from a settled attempt cannot reopen the offer.
    openers.at(0)?.(DESKTOP_URL);
    expect(store.getState()).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
  });

  test("a missing local proof returns to idle without reporting an error", async () => {
    const { store, calls, errors, linked } = scriptedStore();
    const attempt = store.connect("local-proof");
    linked.resolve(Result.ok({ status: "approval-required" }));
    expect(await attempt).toEqual({ status: "approval-required" });
    expect(store.getState()).toEqual({ status: "idle" });
    expect(errors).toEqual([]);
    expect(calls).toEqual(["local-proof"]);
  });

  test("a failed connection reports the error and allows an explicit retry", async () => {
    const { store, calls, errors, linked } = scriptedStore();
    const failure = new Error("connection refused");
    const attempt = store.connect("explicit");
    linked.resolve(Result.err(failure));
    expect(await attempt).toEqual({ status: "error" });
    expect(store.getState()).toEqual({ status: "error" });
    expect(errors).toEqual([failure]);
    expect(await store.connect("explicit")).toEqual({ status: "error" });
    expect(calls).toEqual(["explicit", "explicit"]);
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
    expect(await store.connect("explicit")).toEqual({ status: "error" });
    expect(errors).toEqual([failure]);
    expect(store.getState()).toEqual({ status: "error" });
  });

  test("an update-required refusal is retained without reporting a connection error", async () => {
    const { store, calls, errors, linked } = scriptedStore();
    const states: string[] = [];
    const release = store.subscribe(() => {
      states.push(store.getState().status);
    });
    const attempt = store.connect("explicit");
    linked.resolve(Result.ok({ status: "update-required" }));
    expect(await attempt).toEqual({ status: "update-required" });
    expect(store.getState()).toEqual({ status: "update-required" });
    expect(states).toEqual(["connecting", "update-required"]);
    expect(errors).toEqual([]);
    expect(calls).toEqual(["explicit"]);
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
    expect(await store.connect("explicit")).toEqual({ status: "started" });
    expect(store.getState()).toEqual({ status: "idle" });
    expect(errors).toEqual([]);
  });
});
