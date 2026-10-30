import { describe, expect, test } from "bun:test";

import type { StoredSession } from "./session";
import { createSessionEndBoundary } from "./session-end";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const never = async (): Promise<void> => {
  await new Promise<void>(() => {
    // Never settles.
  });
};

describe("session end boundary", () => {
  test("runs every registered handler with the reason and the session", async () => {
    const boundary = createSessionEndBoundary();
    const seen: string[] = [];
    boundary.register(async (reason, session) => {
      seen.push(`a:${reason}:${session.userId}`);
    });
    boundary.register(async (reason) => {
      seen.push(`b:${reason}`);
    });

    await boundary.run("signed-out", SESSION);

    expect(seen).toHaveLength(2);
    expect(seen).toContain("a:signed-out:user-1");
    expect(seen).toContain("b:signed-out");
  });

  test("an unregistered handler no longer runs, and only its own registration goes", async () => {
    const boundary = createSessionEndBoundary();
    let runs = 0;
    const handler = async () => {
      runs += 1;
    };
    const first = boundary.register(handler);
    boundary.register(handler);
    first();

    await boundary.run("ended", SESSION);

    expect(runs).toBe(1);
  });

  test("a handler that fails or never settles does not hold the session open", async () => {
    const boundary = createSessionEndBoundary(20);
    let finished = false;
    boundary.register(async () => {
      throw new Error("could not save");
    });
    boundary.register(() => {
      throw new Error("threw before returning a promise");
    });
    boundary.register(never);
    boundary.register(async () => {
      finished = true;
    });

    await boundary.run("ended", SESSION);

    expect(finished).toBe(true);
  });
});
