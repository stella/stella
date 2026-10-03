import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { createPendingDocumentQueue } from "@/api/lib/legal-search/sk-document-queue";
import {
  createRemainingDocumentScan,
  DOCUMENT_SCAN_PAGE_LIMIT,
  DOCUMENT_SCAN_REPROBE_MS,
  DOCUMENT_SCAN_ROW_BUDGET,
} from "@/api/lib/legal-search/sk-document-remaining-scan";
import type { RemainingDocumentCandidate } from "@/api/lib/legal-search/sk-document-remaining-scan";

const candidate = (ready: boolean): RemainingDocumentCandidate => ({
  id: createSafeId<"caseLawDecision">(),
  caseNumber: "scan",
  ecli: null,
  court: "court",
  country: "SVK",
  decisionDate: "2026-10-03",
  decisionType: null,
  documentUrl: "https://example.test/document.pdf",
  ready,
});

const fixture = (rows: RemainingDocumentCandidate[]) => {
  let clock = 0;
  let examined = 0;
  let calls = 0;
  const loadRemaining = createRemainingDocumentScan({
    now: () => clock,
    loadPage: async ({ limit, after }) => {
      expect(limit).toBeLessThanOrEqual(DOCUMENT_SCAN_PAGE_LIMIT);
      calls += 1;
      const start = after ? rows.findIndex(({ id }) => id === after.id) + 1 : 0;
      const page = rows.slice(start, start + limit);
      examined += page.length;
      return page;
    },
  });
  const queue = createPendingDocumentQueue({
    loaders: { loadRequested: async () => [], loadRemaining },
    pageSize: 20,
    requestedPollIntervalMs: 0,
    now: () => clock,
  });
  return {
    queue,
    advance: () => {
      clock += DOCUMENT_SCAN_REPROBE_MS;
    },
    examined: () => examined,
    calls: () => calls,
  };
};

test("one queue next crosses cooling pages to find ready work", async () => {
  const ready = candidate(true);
  const f = fixture([
    ...Array.from({ length: DOCUMENT_SCAN_PAGE_LIMIT + 21 }, () =>
      candidate(false),
    ),
    ready,
  ]);
  const result = await f.queue.next();
  expect(result.type).toBe("row");
  if (result.type === "row") {
    expect(result.row.decision.id).toBe(ready.id);
  }
  expect(f.examined()).toBeLessThanOrEqual(DOCUMENT_SCAN_ROW_BUDGET);
});

for (const mode of ["arrival", "expired retry"] as const) {
  test(`head probe finds an ${mode} behind parked pages before archive wrap`, async () => {
    const parked = Array.from({ length: DOCUMENT_SCAN_PAGE_LIMIT + 21 }, () =>
      candidate(false),
    );
    const retry = candidate(false);
    const archive = Array.from({ length: 100 }, () => candidate(true));
    const rows = [...parked, retry, ...archive];
    const f = fixture(rows);
    expect((await f.queue.next()).type).toBe("row");
    for (const row of archive.slice(0, 20)) {
      row.ready = false;
    }
    const fresh = mode === "arrival" ? candidate(true) : retry;
    if (mode === "arrival") {
      rows.splice(parked.length, 0, fresh);
    } else {
      retry.ready = true;
    }
    // Finish the already buffered page, then permit the periodic head probe.
    for (let i = 1; i < 20; i += 1) {
      expect((await f.queue.next()).type).toBe("row");
    }
    f.advance();
    const next = await f.queue.next();
    expect(next.type).toBe("row");
    if (next.type === "row") {
      expect(next.row.decision.id).toBe(fresh.id);
    }
  });
}

test("budget-spent advances on the next call and exhaustion waits for cadence", async () => {
  const ready = candidate(true);
  const f = fixture([
    ...Array.from({ length: DOCUMENT_SCAN_ROW_BUDGET + 21 }, () =>
      candidate(false),
    ),
    ready,
  ]);
  expect(await f.queue.next()).toEqual({ type: "budget-spent" });
  expect(f.examined()).toBe(DOCUMENT_SCAN_ROW_BUDGET);
  const next = await f.queue.next();
  expect(next.type).toBe("row");
  if (next.type === "row") {
    expect(next.row.decision.id).toBe(ready.id);
  }
  const calls = f.calls();
  expect(await f.queue.next()).toEqual({ type: "exhausted" });
  expect(f.calls()).toBe(calls);
  ready.ready = false;
  f.advance();
  expect(await f.queue.next()).toEqual({ type: "budget-spent" });
});

test("a crash mid-buffer replays unclaimed rows from the newest boundary", async () => {
  const rows = Array.from({ length: 25 }, () => candidate(true));
  const process = fixture(rows);
  const first = await process.queue.next();
  expect(first.type).toBe("row");
  if (first.type === "row") {
    const claimed = rows.find(({ id }) => id === first.row.decision.id);
    if (claimed) {
      claimed.ready = false;
    }
  }
  const restarted = fixture(rows);
  const replay = await restarted.queue.next();
  expect(replay.type).toBe("row");
  if (replay.type === "row") {
    expect(replay.row.decision.id).toBe(rows.at(1)?.id);
  }
});

test("a failed later page replays ready rows gathered before the failure", async () => {
  const first = candidate(true);
  const rows = [
    first,
    ...Array.from({ length: DOCUMENT_SCAN_PAGE_LIMIT }, () => candidate(false)),
    candidate(true),
  ];
  let fail = true;
  const scan = createRemainingDocumentScan({
    now: () => 0,
    loadPage: async ({ limit, after }) => {
      if (after && fail) {
        fail = false;
        throw new TypeError("page read failed");
      }
      const start = after ? rows.findIndex(({ id }) => id === after.id) + 1 : 0;
      return rows.slice(start, start + limit);
    },
  });
  await expect(scan(20)).rejects.toThrow("page read failed");
  const result = await scan(20);
  expect(result.type).toBe("rows");
  if (result.type === "rows") {
    expect(result.rows.at(0)?.id).toBe(first.id);
  }
});

test("head probes resume through more than one budget of parked candidates", async () => {
  const rows = Array.from({ length: 100 }, () => candidate(true));
  const f = fixture(rows);
  for (let i = 0; i < 20; i += 1) {
    expect((await f.queue.next()).type).toBe("row");
  }
  for (const row of rows.slice(0, 20)) {
    row.ready = false;
  }
  const fresh = candidate(true);
  rows.unshift(
    ...Array.from({ length: DOCUMENT_SCAN_ROW_BUDGET + 21 }, () =>
      candidate(false),
    ),
    fresh,
  );
  f.advance();
  const before = f.examined();
  expect(await f.queue.next()).toEqual({ type: "budget-spent" });
  expect(f.examined() - before).toBe(DOCUMENT_SCAN_ROW_BUDGET);
  const next = await f.queue.next();
  expect(next.type).toBe("row");
  if (next.type === "row") {
    expect(next.row.decision.id).toBe(fresh.id);
  }
});
