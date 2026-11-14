import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
} from "@/connection/session";
import type { StoredSession } from "@/connection/session";

import type { Timer } from "./timers";
import { discardTimer, matterTimerAction, saveTimer } from "./timers";

const SESSION: StoredSession = {
  signInId: "sign-in-1",
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const TIMER: Timer = {
  id: "timer-1",
  matterId: null,
  description: "Call with the client",
  state: "running",
  accumulatedSeconds: 90,
  lastResumedAt: "2026-10-28T10:00:00.000Z",
};

/** A server that records each request's method, path and body, and answers `{}`. */
const recordingServer = () => {
  const requests: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const path = input.replace(SESSION.serverUrl, "");
    const body = typeof init?.body === "string" ? ` ${init.body}` : "";
    requests.push(`${init?.method ?? "GET"} ${path}${body}`);
    return Response.json({});
  };
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  const source = createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
  return { fetch, requests, source };
};

describe("finishing a timer", () => {
  test("a timer without a matter saves as internal work, dated in the person's zone", async () => {
    const { fetch, requests, source } = recordingServer();
    await saveTimer({ fetch, source, timeZone: "Europe/Prague", timer: TIMER });
    expect(requests).toEqual([
      'POST /v1/time-timers/timer-1/confirm {"timezoneId":"Europe/Prague","activityGroup":"internal"}',
    ]);
  });

  test("a timer on a matter saves as the matter's work", async () => {
    const { fetch, requests, source } = recordingServer();
    await saveTimer({
      fetch,
      source,
      timeZone: "Europe/Prague",
      timer: { ...TIMER, matterId: "matter-1" },
    });
    expect(requests).toEqual([
      'POST /v1/time-timers/timer-1/confirm {"timezoneId":"Europe/Prague"}',
    ]);
  });

  test("discarding deletes the timer", async () => {
    const { fetch, requests, source } = recordingServer();
    await discardTimer({ fetch, source, timer: TIMER });
    expect(requests).toEqual(["DELETE /v1/time-timers/timer-1"]);
  });

  test("a refusal keeps the server's explanation", async () => {
    const fetch: Fetch = async () =>
      Response.json(
        {
          code: "bad_request",
          message: "Billable time entries need an effective rate",
          hint: "Set a rate for the matter.",
        },
        { status: 400 },
      );
    const saved = await saveTimer({
      fetch,
      source: recordingServer().source,
      timeZone: "Europe/Prague",
      timer: TIMER,
    });
    expect(
      saved.isErr() && saved.error._tag === "ApiRequestError"
        ? saved.error.detail
        : undefined,
    ).toBe(
      "Billable time entries need an effective rate Set a rate for the matter.",
    );
  });
});

describe("a matter's timer action", () => {
  const timers = fc.array(
    fc.record({
      id: fc.uuid(),
      matterId: fc.constantFrom(null, "matter-1", "matter-2"),
      state: fc.constantFrom("running" as const, "paused" as const),
    }),
    { maxLength: 6 },
  );

  test("pauses the matter's running timer, else resumes its paused one, else starts", () => {
    assertProperty(
      "pauses the matter's running timer, else resumes its paused one, else starts",
      fc.property(timers, (drawn) => {
        const all = drawn.map((timer): Timer => ({ ...TIMER, ...timer }));
        const own = all.filter((timer) => timer.matterId === "matter-1");
        const action = matterTimerAction(all, "matter-1");
        switch (action.type) {
          case "pause":
            expect(own).toContain(action.timer);
            expect(action.timer.state).toBe("running");
            return;
          case "resume":
            expect(own).toContain(action.timer);
            expect(own.every((timer) => timer.state === "paused")).toBe(true);
            return;
          case "start":
            expect(own).toEqual([]);
        }
      }),
    );
  });

  test("leaves another matter's running timer alone", () => {
    expect(
      matterTimerAction([{ ...TIMER, matterId: "matter-2" }], "matter-1"),
    ).toEqual({ type: "start" });
  });
});
