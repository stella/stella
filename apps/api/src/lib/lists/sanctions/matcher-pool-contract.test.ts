import { expect, test } from "bun:test";
import { MessageChannel, Worker } from "node:worker_threads";

import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  SANCTIONS_SOURCES,
  screen,
} from "@stll/sanctions";
import type { ParsedList, ScreeningQuery } from "@stll/sanctions";

import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createSanctionsMatcherPool } from "./matcher-pool";
import type { MatcherWorkOutcome } from "./matcher-pool";
import type { SanctionsMatcherRequest } from "./matcher-protocol";
import type { reportSanctionsScreeningFailure } from "./screening-failure";
import { createMatcherTestClock } from "./test-fixtures/matcher-test-clock";

const outcomeValue = <T>(outcome: MatcherWorkOutcome<T>): T | null =>
  outcome.status === "completed" ? outcome.value : null;

const personList = (name: string): ParsedList => ({
  version: { source: "eu", publishedAt: "2026-09-20", fileId: null },
  entries: [
    {
      source: "eu",
      issuer: SANCTIONS_SOURCES.eu.issuer,
      sourceId: "multilingual-person",
      referenceNumber: null,
      entityType: "person",
      names: [{ name, quality: "strong" }],
      birthDates: [
        { precision: "day", year: 1960, month: 5, day: 12, circa: false },
      ],
      nationalities: [{ code: "CZ", name: "Czechia" }],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://lists.example/eu",
    },
  ],
});

const multilingualCases = [
  {
    name: "Čeněk Říha",
    listed: "Čeněk Říha",
    birthDate: { year: 1960 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
  {
    name: "Ján Šťastný",
    listed: "Ján Šťastný",
    birthDate: { year: 1960, month: 5 },
    nationalityCodes: ["SK"],
    dateEvidence: "match",
    nationalityEvidence: "mismatch",
  },
  {
    name: "Иван Сидоров",
    listed: "Иван Сидоров",
    birthDate: { year: 1960, month: 5, day: 12 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
  {
    name: "Ivan Sidorov",
    listed: "Иван Сидоров",
    birthDate: { year: 1971 },
    nationalityCodes: ["CZ"],
    dateEvidence: "mismatch",
    nationalityEvidence: "match",
  },
  {
    name: "Ľuboš Ďur",
    listed: "Ľuboš Ďur",
    birthDate: { year: 1960 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
  {
    name: "Jána Šťastného",
    listed: "Jána Šťastného",
    birthDate: { year: 1960 },
    nationalityCodes: ["CZ"],
    dateEvidence: "match",
    nationalityEvidence: "match",
  },
] as const;

test.each(multilingualCases)(
  "real worker preserves multilingual identity and partial-date evidence ($name)",
  async (fixture) => {
    expect("Čeněk Říha".normalize("NFD")).not.toBe("Čeněk Říha");
    const pool = createSanctionsMatcherPool({
      size: 1,
      clock: createMatcherTestClock(),
    });
    const list = personList(fixture.listed);
    const index = buildScreeningIndex([list]);
    try {
      for (const name of [fixture.name, fixture.name.normalize("NFD")]) {
        const query = {
          name,
          entityType: "person",
          birthDate: fixture.birthDate,
          nationality: [...fixture.nationalityCodes],
        } as const satisfies ScreeningQuery;
        const expected = screen(index, query, {
          cutoff: DEFAULT_CUTOFF,
          limit: 10,
        }).unwrap();
        expect(expected.possibleMatches.at(0)?.entry.sourceId).toBe(
          "multilingual-person",
        );
        expect(
          expected.possibleMatches.at(0)?.evidence.nameScore,
        ).toBeGreaterThan(0);
        expect(expected.possibleMatches.at(0)?.evidence.birthDate).toBe(
          fixture.dateEvidence,
        );
        expect(expected.possibleMatches.at(0)?.evidence.nationality).toBe(
          fixture.nationalityEvidence,
        );
        const request = {
          source: "eu",
          editionId: "multilingual",
          query,
          list,
          cutoff: DEFAULT_CUTOFF,
          limit: 10,
        } as const satisfies SanctionsMatcherRequest;
        expect(
          await pool
            .run(async (session) => await session.match(request))
            .then(outcomeValue),
        ).toEqual({ status: "screened", result: expected });
        expect(
          await pool
            .run(
              async (session) =>
                await session.match({ ...request, list: null }),
            )
            .then(outcomeValue),
        ).toEqual({ status: "screened", result: expected });
      }
    } finally {
      await pool.close();
    }
  },
);

test.each([1, 2])(
  "pool refuses excess simultaneous waiters and serves admitted callers (size %s)",
  async (size) => {
    const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
    const pool = createSanctionsMatcherPool({
      reportFailure: (report) => reports.push(report),
      size,
      clock: createMatcherTestClock(),
    });
    const activeEntered = Promise.withResolvers<undefined>();
    const releaseActive = Promise.withResolvers<undefined>();
    const queued = Array.from({ length: 2 }, () => ({
      entered: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
    }));
    const signals: AbortSignal[] = [];
    let running = 0;
    let peak = 0;
    const executed: number[] = [];
    const active = Array.from(
      { length: size },
      async (_, index) =>
        await pool
          .run(async (session) => {
            signals.push(session.signal);
            executed.push(index);
            running += 1;
            peak = Math.max(peak, running);
            if (running === size) {
              activeEntered.resolve(undefined);
            }
            await releaseActive.promise;
            running -= 1;
            return index;
          })
          .then(outcomeValue),
    );
    const pending: Promise<number | null>[] = [];
    try {
      await activeEntered.promise;
      pending.push(
        ...queued.map(
          async (gate, index) =>
            await pool
              .run(async (session) => {
                signals.push(session.signal);
                executed.push(size + index);
                running += 1;
                peak = Math.max(peak, running);
                gate.entered.resolve(undefined);
                await gate.release.promise;
                running -= 1;
                return size + index;
              })
              .then(outcomeValue),
        ),
      );
      const refused = pool
        .run(async () => {
          executed.push(-1);
          return -1;
        })
        .then(outcomeValue);
      expect(await refused).toBeNull();
      expect(reports.map(({ reason }) => reason)).toEqual(["admission"]);
      expect(signals).toHaveLength(size);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(executed).toEqual(
        Array.from({ length: size }, (_, index) => index),
      );
      releaseActive.resolve(undefined);
      for (const gate of queued) {
        await gate.entered.promise;
        gate.release.resolve(undefined);
      }
      expect(await Promise.all([...active, ...pending])).toEqual(
        Array.from({ length: size + 2 }, (_, index) => index),
      );
      expect(executed.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: size + 2 }, (_, index) => index),
      );
      expect(peak).toBe(size);
    } finally {
      releaseActive.resolve(undefined);
      for (const gate of queued) {
        gate.release.resolve(undefined);
      }
      await Promise.all([...active, ...pending]);
      await pool.close();
    }
  },
  15_000,
);

test("close cancels active and queued leases and prevents respawn", async () => {
  const { port1, port2 } = new MessageChannel();
  const entered = Promise.withResolvers<undefined>();
  const exited = Promise.withResolvers<undefined>();
  port1.once("message", () => entered.resolve(undefined));
  let spawned = 0;
  let invoked = 0;
  const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
  const pool = createSanctionsMatcherPool({
    reportFailure: (report) => reports.push(report),
    size: 1,
    clock: createMatcherTestClock(),
    createWorker: () => {
      spawned += 1;
      const worker = new Worker(
        new URL("test-fixtures/matcher-close-worker.ts", import.meta.url),
        {
          workerData: { acknowledgement: port2 },
          transferList: [port2],
        },
      );
      worker.once("exit", () => exited.resolve(undefined));
      return worker;
    },
  });
  const active = pool
    .run(async (session) => {
      invoked += 1;
      return await session.match({
        source: "eu",
        editionId: "close",
        list: personList("Čeněk Říha"),
        query: { name: "Čeněk Říha", entityType: "person" },
        cutoff: DEFAULT_CUTOFF,
        limit: 10,
      });
    })
    .then(outcomeValue);
  try {
    await entered.promise;
    const queued = pool
      .run(async () => {
        invoked += 1;
        return "queued";
      })
      .then(outcomeValue);
    const began = performance.now();
    await pool.close();
    expect(await active).toBeNull();
    expect(await queued).toBeNull();
    console.info(
      JSON.stringify({
        matcherCloseMs: Number((performance.now() - began).toFixed(2)),
      }),
    );
    await exited.promise;
    expect(invoked).toBe(1);
    expect(
      await pool
        .run(async () => {
          invoked += 1;
          return "after-close";
        })
        .then(outcomeValue),
    ).toBeNull();
    expect(invoked).toBe(1);
    expect(spawned).toBe(1);
    expect(reports.map(({ reason }) => reason)).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
    await pool.close();
  } finally {
    await pool.close();
    await active;
    port1.close();
    port2.close();
  }
}, 15_000);

test("close waits for actual worker retirement", async () => {
  const retirement = Promise.withResolvers<number>();
  const entered = Promise.withResolvers<undefined>();
  let retired = 0;
  let closed = false;
  const pool = createSanctionsMatcherPool({
    clock: createMatcherTestClock(),
    createWorker: () => {
      const events = { on: () => undefined };
      return asTestRaw<Worker>(
        Object.assign(events, {
          unref: () => events,
          terminate: async () => {
            retired += 1;
            return await retirement.promise;
          },
        }),
      );
    },
  });
  const active = pool
    .run(async (session) => {
      entered.resolve(undefined);
      await new Promise<void>((resolve) => {
        session.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return "cancelled";
    })
    .then(outcomeValue);
  try {
    await entered.promise;
    const closing = pool.close().then(() => {
      closed = true;
      return undefined;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(retired).toBe(1);
    expect(closed).toBe(false);
    retirement.resolve(0);
    await closing;
    expect(closed).toBe(true);
    expect(await active).toBeNull();
    await pool.close();
    expect(retired).toBe(1);
  } finally {
    retirement.resolve(0);
    await pool.close();
    await active;
  }
});

test("real worker honors cutoff and limit on cold and cached requests", async () => {
  const template = personList("Alex Novak").entries.at(0);
  if (template === undefined) {
    throw new TypeError("Missing protocol fixture");
  }
  const list = {
    version: personList("Alex Novak").version,
    entries: [
      ...Array.from({ length: 3 }, (_, index) => ({
        ...template,
        sourceId: `exact-${index}`,
      })),
      {
        ...template,
        sourceId: "near",
        names: [{ name: "Alek Novak", quality: "strong" as const }],
      },
    ],
  } satisfies ParsedList;
  const query = {
    name: "Alex Novak",
    entityType: "person",
  } as const satisfies ScreeningQuery;
  const index = buildScreeningIndex([list]);
  const low = screen(index, query, { cutoff: 0.5, limit: 20 }).unwrap();
  const high = screen(index, query, { cutoff: 0.999, limit: 20 }).unwrap();
  expect(low.totalMatches).toBeGreaterThan(high.totalMatches);
  expect(
    low.possibleMatches.some(({ entry }) => entry.sourceId === "near"),
  ).toBe(true);
  expect(
    high.possibleMatches.map(({ entry }) => entry.sourceId).toSorted(),
  ).toEqual(["exact-0", "exact-1", "exact-2"]);
  const pool = createSanctionsMatcherPool({
    size: 1,
    clock: createMatcherTestClock(),
  });
  try {
    for (const cutoff of [0.5, 0.999]) {
      for (const limit of [1, 2, 20]) {
        const expected = screen(index, query, { cutoff, limit }).unwrap();
        expect(expected.possibleMatches).toHaveLength(
          Math.min(limit, expected.totalMatches),
        );
        expect(expected.truncated).toBe(limit < expected.totalMatches);
        const request = {
          source: "eu",
          editionId: `cutoff-${cutoff}-limit-${limit}`,
          list,
          query,
          cutoff,
          limit,
        } as const satisfies SanctionsMatcherRequest;
        const cold = await pool
          .run(async (session) => await session.match(request))
          .then(outcomeValue);
        expect(cold).toEqual({ status: "screened", result: expected });
        expect(
          await pool
            .run(
              async (session) =>
                await session.match({ ...request, list: null }),
            )
            .then(outcomeValue),
        ).toEqual(cold);
      }
    }
  } finally {
    await pool.close();
  }
});
