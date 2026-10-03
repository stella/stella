import { panic } from "better-result";
import { expect, jest, mock, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import {
  withImmediatePublisherSlot,
  reservePublisherSlot,
} from "../ingestion/adapters/publisher-policy";
import { fetchPublisher } from "../ingestion/adapters/retry";
import {
  readThroughDeferredDocument,
  type OnDemandDocumentDeps,
} from "./document-on-demand";

const decision = (): PendingDocument => ({
  id: createSafeId<"caseLawDecision">(),
  caseNumber: "1/2026",
  ecli: null,
  court: "Court",
  country: "SVK",
  decisionDate: "2026-01-01",
  decisionType: null,
  documentUrl: "https://example.test/document.pdf",
});

const pacedDeps = ({
  tokens,
  backoff = false,
}: {
  tokens: number;
  backoff?: boolean;
}) => {
  let available = tokens;
  let reservations = 0;
  const fetched: SafeId<"caseLawDecision">[] = [];
  const deferred: SafeId<"caseLawDecision">[] = [];
  const deps: OnDemandDocumentDeps = {
    recordRequest: async () => {},
    recordPacingOutcome: (id) => {
      deferred.push(id);
    },
    withFetchBudget: async (adapterKey, operation) =>
      await withImmediatePublisherSlot({
        adapterKey,
        dependencies: {
          redis: () => ({
            send: () => {
              reservations += 1;
              if (backoff || available === 0) {
                return 0;
              }
              available -= 1;
              return 1;
            },
          }),
          sleep: async () => {
            throw new Error("Immediate reservation must not sleep");
          },
        },
        operation,
      }),
    fetchDocument: async (pending, adapterKey) => {
      // The fetch boundary takes the immediate shared reservation.
      await reservePublisherSlot(adapterKey);
      fetched.push(pending.id);
      return { status: "claimed" };
    },
  };
  return { deps, fetched, deferred, reservations: () => reservations };
};

test("a read consumes one shared source reservation", async () => {
  const { deps, fetched, reservations } = pacedDeps({ tokens: 1 });
  const pending = decision();
  expect(
    await readThroughDeferredDocument({
      decision: pending,
      adapterKey: "sk-courts",
      deps,
      recordDemand: false,
    }),
  ).toBeNull();
  expect(fetched).toEqual([pending.id]);
  expect(reservations()).toBe(1);
});

for (const state of [{ tokens: 0 }, { tokens: 1, backoff: true }]) {
  test(`source pacing returns metadata and records deferral with ${state.backoff ? "backoff" : "no slot"}`, async () => {
    const { deps, fetched, deferred } = pacedDeps(state);
    const pending = decision();
    expect(
      await readThroughDeferredDocument({
        decision: pending,
        adapterKey: "sk-courts",
        deps,
        recordDemand: false,
      }),
    ).toBeNull();
    expect(fetched).toEqual([]);
    expect(deferred).toEqual([pending.id]);
  });
}

test("an inline source does not reserve or fetch a document", async () => {
  const { deps, fetched, reservations } = pacedDeps({ tokens: 1 });
  expect(
    await readThroughDeferredDocument({
      decision: decision(),
      adapterKey: "cz-ns",
      deps,
      recordDemand: false,
    }),
  ).toBeNull();
  expect(fetched).toEqual([]);
  expect(reservations()).toBe(0);
});

test("concurrent reads resolve within the shared source budget", async () => {
  await assertProperty(
    "concurrent reads resolve within the shared source budget",
    fc.asyncProperty(
      fc.array(fc.nat({ max: 8 }), { minLength: 1, maxLength: 20 }),
      fc.nat({ max: 20 }),
      async (turns, tokens) => {
        const { deps, fetched } = pacedDeps({ tokens });
        const results = await Promise.all(
          turns.map(async (delay) => {
            for (let turn = 0; turn < delay; turn += 1) {
              await Promise.resolve();
            }
            return await readThroughDeferredDocument({
              decision: decision(),
              adapterKey: "sk-courts",
              deps,
              recordDemand: false,
            });
          }),
        );
        expect(results).toEqual(turns.map(() => null));
        expect(fetched.length).toBeLessThanOrEqual(
          Math.min(tokens, turns.length),
        );
      },
    ),
  );
});

for (const mode of ["throws", "rejects", "pending", "connecting"] as const) {
  test(`an unavailable source gate ${mode} and returns metadata without a request`, async () => {
    jest.useFakeTimers();
    let requests = 0;
    let gateCalls = 0;
    let resolved = false;
    const recorded: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchMock(
      mock(async () => {
        requests += 1;
        return new Response("document");
      }),
    );
    const deps: OnDemandDocumentDeps = {
      recordRequest: async () => {},
      recordPacingOutcome: (_id, outcome) => {
        recorded.push(outcome);
      },
      withFetchBudget: async (adapterKey, operation) =>
        await withImmediatePublisherSlot({
          adapterKey,
          dependencies: {
            redis: async () =>
              mode === "connecting"
                ? new Promise(() => {})
                : {
                    send: async () => {
                      gateCalls += 1;
                      switch (mode) {
                        case "throws":
                          throw new Error("Budget unavailable");
                        case "rejects":
                          throw new Error("Budget unavailable");
                        case "pending":
                          return new Promise(() => {});
                        default:
                          mode satisfies never;
                          return panic("Unhandled gate failure mode");
                      }
                    },
                  },
            sleep: async () => {
              throw new Error("Immediate reservation must not sleep");
            },
          },
          operation,
        }),
      fetchDocument: async (_pending, adapterKey) => {
        await fetchPublisher("https://obcan.justice.sk/document.pdf", {
          adapterKey,
          fetchStage: "document",
          timeoutMs: 1000,
        });
        return { status: "claimed" };
      },
    };
    try {
      const read = readThroughDeferredDocument({
        decision: decision(),
        adapterKey: "sk-courts",
        deps,
        recordDemand: false,
      }).then((result) => {
        resolved = true;
        return result;
      });
      for (let turn = 0; turn < 40; turn += 1) {
        await Promise.resolve();
      }
      expect(gateCalls).toBe(mode === "connecting" ? 0 : 1);
      if (mode === "pending" || mode === "connecting") {
        jest.advanceTimersByTime(4999);
        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(requests).toBe(0);
        jest.advanceTimersByTime(1);
      }
      expect(await read).toBeNull();
      expect(resolved).toBe(true);
      expect(requests).toBe(0);
      expect(recorded).toEqual(["pacing-unavailable"]);
      // Advancing past the read budget does not resume an unreserved request.
      jest.advanceTimersByTime(6000);
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      jest.useRealTimers();
    }
  });
}

test("a pacing capture failure still resolves the read", async () => {
  const { deps, fetched } = pacedDeps({ tokens: 0 });
  deps.recordPacingOutcome = () => {
    throw new Error("Capture unavailable");
  };
  expect(
    await readThroughDeferredDocument({
      decision: decision(),
      adapterKey: "sk-courts",
      deps,
      recordDemand: false,
    }),
  ).toBeNull();
  expect(fetched).toEqual([]);
});

test("an immediate publisher operation reports its failure", async () => {
  const failure = new Error("Document operation failed");
  const result = await withImmediatePublisherSlot({
    adapterKey: "sk-courts",
    dependencies: {
      redis: () => ({ send: () => 1 }),
      sleep: async () => {},
    },
    operation: async () => {
      throw failure;
    },
  });
  expect(result).toEqual({ status: "failed", error: failure });
});
