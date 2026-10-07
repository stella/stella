import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import type { OperatorActivitySummary } from "@/api/lib/db/operator-activity/read";

import { createOperatorActivity } from "./activity";

const NOW = Date.parse("2026-10-05T08:00:00Z");
const summary = {
  generated_at: "2026-10-05T08:00:00Z",
  users_acting_5m: 2,
  users_acting_today: 5,
  signups_today: 2,
  signups_7d: 8,
  chat_turns_1h: 3,
  tool_calls_1h: null,
  unavailable_reasons: {
    tool_calls_1h:
      "No durable tool-call event source records execution timestamps.",
  },
} satisfies OperatorActivitySummary;

const createApp = (options: Parameters<typeof createOperatorActivity>[0]) => {
  const activity = createOperatorActivity(options);
  return new Elysia().get("/operator/activity", activity.handler, {
    query: activity.config.query,
  });
};

const request = (query: string, headers?: HeadersInit) =>
  new Request(`http://localhost/operator/activity${query}`, { headers });

describe("operator activity HTTP boundary", () => {
  test("refuses disabled and unauthorized credentials before reading or validating queries", async () => {
    const secret = Bun.randomUUIDv7();
    for (const { configuredToken, headers, status } of [
      {
        configuredToken: undefined,
        headers: { authorization: `Bearer ${secret}` },
        status: 404,
      },
      { configuredToken: secret, headers: {}, status: 401 },
      {
        configuredToken: secret,
        headers: { authorization: `Bearer ${Bun.randomUUIDv7()}` },
        status: 401,
      },
      {
        configuredToken: secret,
        headers: { cookie: "better-auth.session_token=non-operator-session" },
        status: 401,
      },
    ]) {
      let reads = 0;
      const app = createApp({
        configuredToken: () => configuredToken,
        now: () => NOW,
        readSummary: async () => {
          reads += 1;
          return summary;
        },
      });
      for (const query of ["", "?email=private@example.test&limit=-1"]) {
        const response = await app.handle(request(query, headers));
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.text();
        expect(body).not.toContain(secret);
        expect(body).not.toContain("private@example.test");
        expect(body).not.toContain("limit");
      }
      expect(reads).toBe(0);
    }
  });

  test("projects only activity counts, timestamp and unavailable reasons", async () => {
    const secret = Bun.randomUUIDv7();
    const readTimes: number[] = [];
    const app = createApp({
      configuredToken: () => secret,
      now: () => NOW,
      readSummary: async (now) => {
        readTimes.push(now);
        return {
          ...summary,
          email: "private@example.test",
          user_id: "private-user",
          unavailable_reasons: {
            ...summary.unavailable_reasons,
            email: "private@example.test",
          },
        };
      },
    });
    const response = await app.handle(
      request("", { authorization: `Bearer ${secret}` }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(summary);
    expect(readTimes).toEqual([NOW]);
  });

  test("rejects every supplied query parameter after authorization without reading", async () => {
    const secret = Bun.randomUUIDv7();
    let reads = 0;
    const app = createApp({
      configuredToken: () => secret,
      readSummary: async () => {
        reads += 1;
        return summary;
      },
    });
    for (const query of [
      "?since=2026-10-04",
      "?limit=1",
      "?unknown=",
      "?unknown=a&unknown=b",
    ]) {
      const response = await app.handle(
        request(query, { authorization: `Bearer ${secret}` }),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(reads).toBe(0);
  });

  test("surfaces read failures without leaking their details", async () => {
    const secret = Bun.randomUUIDv7();
    const app = createApp({
      configuredToken: () => secret,
      readSummary: async () => {
        throw new TypeError("activity read failed for private@example.test");
      },
    });
    const response = await app.handle(
      request("", { authorization: `Bearer ${secret}` }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).not.toContain("activity read failed");
    expect(body).not.toContain("private@example.test");
  });
});
