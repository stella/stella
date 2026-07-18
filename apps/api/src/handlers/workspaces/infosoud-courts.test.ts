import { describe, expect, mock, test } from "bun:test";

import { InfoSoudClient } from "@stll/infosoud";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The handler's district-court load must never run once the courts load has
 * already failed. The shared InfoSoud client serializes both calls through
 * one politeness throttle, so `Promise.all`-ing them provides zero
 * concurrency here; it only enqueues the district load behind the courts
 * load, which then still fires against InfoSoud after the handler has
 * already returned its error response. Building a real client (with a fake
 * `fetch` counting calls) instead of a hand-rolled stub pins the fix against
 * the actual shared-throttle mechanics, not just the handler's own control
 * flow.
 */
const createFailingFirstCallClient = (): {
  client: InfoSoudClient;
  fetchCallCount: () => number;
} => {
  let fetchCount = 0;
  const client = new InfoSoudClient({
    delayMs: 0,
    fetch: async () => {
      fetchCount += 1;
      throw new TypeError("network unreachable");
    },
  });

  return { client, fetchCallCount: () => fetchCount };
};

let tracked = createFailingFirstCallClient();

void mock.module("@/api/handlers/workspaces/infosoud-common", () => ({
  getInfoSoudClient: () => tracked.client,
}));

const { default: infosoudCourts } = await import("./infosoud-courts");

type InfosoudCourtsContext = Parameters<typeof infosoudCourts.handler>[0];

const createContext = (): InfosoudCourtsContext =>
  asTestRaw<InfosoudCourtsContext>({
    memberRole: { role: "owner" },
    query: {},
    request: new Request("https://example.test/infosoud-courts"),
    route: "/infosoud-courts",
    session: {
      activeOrganizationId: toSafeId<"organization">(
        "019e7000-0000-7000-8000-000000000002",
      ),
    },
    set: { headers: {} },
    user: { id: toSafeId<"user">("019e7000-0000-7000-8000-000000000001") },
  });

describe("infosoudCourts", () => {
  test("does not queue the district-court load after the courts load fails", async () => {
    tracked = createFailingFirstCallClient();

    const result = await infosoudCourts.handler(createContext());

    if (!("code" in result)) {
      throw new Error("Expected the courts load failure to return a status");
    }
    expect(result.code).toBe(502);
    // Sequential awaits short-circuit on the first rejection: the
    // district-court call is never issued, so only one fetch ever fires.
    // Reintroducing Promise.all here would enqueue it regardless of the
    // first call's outcome, bumping this to 2.
    expect(tracked.fetchCallCount()).toBe(1);
  });
});
