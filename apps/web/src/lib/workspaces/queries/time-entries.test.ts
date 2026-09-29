import { QueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";

import { activeTimerOptions } from "./time-entries";

const requests: URL[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    await Promise.resolve();
    requests.push(new URL(input instanceof Request ? input.url : input));
    return Response.json({ items: [], limit: 50, nextCursor: null });
  },
  { preconnect: () => undefined },
);

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("active timer", () => {
  test("asks for the signed-in user's own running timer", async () => {
    const timer = await new QueryClient().query(
      activeTimerOptions("workspace-a", "user-a"),
    );

    expect(timer).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("scope")).toBe("me");
    expect(requests[0]?.searchParams.get("hasActiveTimer")).toBe("true");
  });
});
