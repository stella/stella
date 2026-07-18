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

/**
 * Two concurrent /infosoud-courts requests hitting a cold courts cache must
 * share one in-flight load: the handler calls client.getCourts() and
 * client.getDistrictCourts() without threading request.signal, so the
 * shared client's #getCachedOrLoad dedup keeps both endpoints' fetches
 * shared instead of each caller starting its own redundant throttled
 * fetch. Holding the fetch open until both handler calls have started
 * proves the second caller actually joins the first's in-flight load
 * rather than merely benefiting from a fast synchronous resolution.
 */
const createGatedCourtsClient = (): {
  client: InfoSoudClient;
  fetchCallCountByPath: () => Record<string, number>;
  release: () => void;
} => {
  const fetchCallCountByPath: Record<string, number> = {};
  let releaseFetch: (() => void) | undefined;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const client = new InfoSoudClient({
    delayMs: 0,
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      fetchCallCountByPath[path] = (fetchCallCountByPath[path] ?? 0) + 1;
      await fetchGate;
      return path.endsWith("/organizace/lov")
        ? new Response(
            JSON.stringify([
              { kod: "KSUL", nazev: "Krajský soud Ústí nad Labem" },
            ]),
            { headers: { "content-type": "application/json" } },
          )
        : new Response(
            JSON.stringify([{ kod: "OSSCEDC", nazev: "Okresní soud Děčín" }]),
            { headers: { "content-type": "application/json" } },
          );
    },
  });

  return {
    client,
    fetchCallCountByPath: () => fetchCallCountByPath,
    release: () => releaseFetch?.(),
  };
};

let activeClient: InfoSoudClient = createFailingFirstCallClient().client;

void mock.module("@/api/handlers/workspaces/infosoud-common", () => ({
  getInfoSoudClient: () => activeClient,
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
    const tracked = createFailingFirstCallClient();
    activeClient = tracked.client;

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

  test("two concurrent requests on a cold courts cache share one in-flight load", async () => {
    const gated = createGatedCourtsClient();
    activeClient = gated.client;

    // Fire both handler calls without awaiting either first, so the second
    // reaches the shared client's in-flight check while the first call's
    // load is still pending behind the gate.
    const firstRequest = infosoudCourts.handler(createContext());
    const secondRequest = infosoudCourts.handler(createContext());

    gated.release();

    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    if ("code" in first || "code" in second) {
      throw new Error("Expected both concurrent requests to succeed");
    }
    expect(first).toEqual(second);
    // One fetch per endpoint total, not one per endpoint per caller: a
    // caller passing its own AbortSignal into client.getCourts()/
    // getDistrictCourts() here would disable #getCachedOrLoad's in-flight
    // sharing and double this to 2 fetches per path.
    const fetchCounts = Object.values(gated.fetchCallCountByPath());
    expect(fetchCounts).toHaveLength(2);
    expect(fetchCounts.every((count) => count === 1)).toBe(true);
  });
});
