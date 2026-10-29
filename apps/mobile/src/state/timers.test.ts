import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import { createAccessTokenSource } from "@/connection/session";
import type { StoredSession } from "@/connection/session";

import type { Timer } from "./timers";
import { clockOf, discardTimer, elapsedSeconds, saveTimer } from "./timers";

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
  const source = createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store: {
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    },
  });
  return { fetch, requests, source };
};

describe("a timer's time", () => {
  test("a running timer adds the seconds since it resumed", () => {
    const now = Date.UTC(2026, 9, 28, 10, 2, 30);
    expect(elapsedSeconds(TIMER, now)).toBe(90 + 150);
  });

  test("a paused timer keeps what it counted", () => {
    const paused: Timer = { ...TIMER, state: "paused", lastResumedAt: null };
    expect(elapsedSeconds(paused, Date.UTC(2030, 0, 1))).toBe(90);
  });

  test("reads as a clock", () => {
    expect(clockOf(309)).toBe("0:05:09");
    expect(clockOf(45_000)).toBe("12:30:00");
  });
});

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
