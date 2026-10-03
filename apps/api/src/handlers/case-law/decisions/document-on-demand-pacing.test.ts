import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";

import {
  withImmediatePublisherSlot,
  reservePublisherSlot,
} from "../ingestion/adapters/publisher-policy";
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
    recordPacingDeferred: (id) => {
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
      // The fetch boundary spends the acquired slot without reserving again.
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

test("a source budget failure resolves the read without fetching", async () => {
  let fetched = 0;
  const deps: OnDemandDocumentDeps = {
    recordRequest: async () => {},
    recordPacingDeferred: () => {},
    withFetchBudget: async (adapterKey, operation) =>
      await withImmediatePublisherSlot({
        adapterKey,
        dependencies: {
          redis: () => ({
            send: () => {
              throw new Error("Budget unavailable");
            },
          }),
          sleep: async () => {},
        },
        operation,
      }),
    fetchDocument: async () => {
      fetched += 1;
      return { status: "claimed" };
    },
  };
  expect(
    await readThroughDeferredDocument({
      decision: decision(),
      adapterKey: "sk-courts",
      deps,
      recordDemand: false,
    }),
  ).toBeNull();
  expect(fetched).toBe(0);
});

test("a pacing capture failure still resolves the read", async () => {
  const { deps, fetched } = pacedDeps({ tokens: 0 });
  deps.recordPacingDeferred = () => {
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
