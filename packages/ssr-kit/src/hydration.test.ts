import { describe, expect, test } from "bun:test";

import { bootHydratedClient } from "./hydration";

describe("client hydration boot", () => {
  test("hydrates server markup before deferred browser state", async () => {
    const events: string[] = [];
    let continueAfterPaint: (() => void) | undefined;
    const afterPaint = new Promise<void>((resolve) => {
      continueAfterPaint = resolve;
    });
    const completion = bootHydratedClient({
      type: "server-rendered",
      hydrate: () => {
        events.push("hydrate");
      },
      initializeClientState: async () => {
        events.push("initialize");
      },
      scheduleAfterPaint: async () => {
        events.push("schedule");
        await afterPaint;
      },
    });

    expect(events).toEqual(["hydrate", "schedule"]);
    continueAfterPaint?.();
    await completion;
    expect(events).toEqual(["hydrate", "schedule", "initialize"]);
  });

  test("initializes browser state before rendering a client-only document", async () => {
    const events: string[] = [];
    await bootHydratedClient({
      type: "client-rendered",
      hydrate: () => {
        events.push("hydrate");
      },
      initializeClientState: async () => {
        events.push("initialize");
      },
    });

    expect(events).toEqual(["initialize", "hydrate"]);
  });

  test("still hydrates a client-only document when initialization rejects", async () => {
    const events: string[] = [];
    const failure = new TypeError("state unavailable");
    const completion = bootHydratedClient({
      type: "client-rendered",
      hydrate: () => {
        events.push("hydrate");
      },
      initializeClientState: async () => {
        throw failure;
      },
    });

    try {
      await completion;
      throw new TypeError("Expected client state initialization to fail.");
    } catch (error) {
      expect(error).toBe(failure);
    }
    expect(events).toEqual(["hydrate"]);
  });
});
