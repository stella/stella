import { describe, expect, test } from "bun:test";

import { bootHydratedClient } from "./hydration";

describe("client hydration boot", () => {
  test("waits for the server markup to commit before loading browser state", async () => {
    const events: string[] = [];
    const hydrationCommit = Promise.withResolvers<undefined>();
    const completion = bootHydratedClient({
      type: "server-rendered",
      hydrate: async () => {
        events.push("hydrate");
        await hydrationCommit.promise;
        events.push("commit");
      },
      initializeClientState: async () => {
        events.push("initialize");
      },
    });

    expect(events).toEqual(["hydrate"]);
    hydrationCommit.resolve(undefined);
    await completion;
    expect(events).toEqual(["hydrate", "commit", "initialize"]);
  });

  test("initializes browser state before rendering a client-only document", async () => {
    const events: string[] = [];
    await bootHydratedClient({
      type: "client-rendered",
      hydrate: async () => {
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
      hydrate: async () => {
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
