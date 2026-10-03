import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  createRemainingDocumentScan,
  DOCUMENT_SCAN_PAGE_LIMIT,
  DOCUMENT_SCAN_REPROBE_MS,
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

test("remaining scan advances past an entirely cooling batch without exceeding its budget", async () => {
  const cooling = Array.from({ length: DOCUMENT_SCAN_PAGE_LIMIT }, () =>
    candidate(false),
  );
  const ready = candidate(true);
  const requests: number[] = [];
  const scan = createRemainingDocumentScan({
    loadPage: async ({ limit, after }) => {
      requests.push(limit);
      if (!after) {
        return cooling;
      }
      expect(after.id).toBe(cooling.at(-1)?.id);
      return [ready];
    },
    now: () => 0,
  });
  expect(await scan(10_000)).toEqual([]);
  expect((await scan(10_000)).map(({ id }) => id)).toEqual([ready.id]);
  expect(requests).toEqual([
    DOCUMENT_SCAN_PAGE_LIMIT,
    DOCUMENT_SCAN_PAGE_LIMIT,
  ]);
});

test("empty and exhausted scans do not probe again before the cadence boundary", async () => {
  for (const page of [[], [candidate(true)]]) {
    let clock = 0;
    let calls = 0;
    const scan = createRemainingDocumentScan({
      now: () => clock,
      loadPage: async ({ after }) => {
        expect(after).toBeUndefined();
        calls += 1;
        return page;
      },
    });
    await scan(5);
    clock = DOCUMENT_SCAN_REPROBE_MS - 1;
    expect(await scan(5)).toEqual([]);
    expect(calls).toBe(1);
    clock += 1;
    await scan(5);
    expect(calls).toBe(2);
  }
});

test("failed page reads retain the previous cursor", async () => {
  const first = candidate(true);
  let calls = 0;
  const scan = createRemainingDocumentScan({
    now: () => 0,
    loadPage: async ({ after }) => {
      calls += 1;
      if (calls === 1) {
        return [first];
      }
      expect(after?.id).toBe(first.id);
      if (calls === 2) {
        throw new TypeError("read failed");
      }
      return [];
    },
  });
  await scan(1);
  await expect(scan(1)).rejects.toThrow("read failed");
  expect(await scan(1)).toEqual([]);
});

test("newest arrivals overtake an active sweep without resetting its cursor", async () => {
  const first = candidate(false);
  const arrival = candidate(true);
  const older = candidate(true);
  let clock = 0;
  let calls = 0;
  const scan = createRemainingDocumentScan({
    now: () => clock,
    loadPage: async ({ after }) => {
      calls += 1;
      if (calls === 1) {
        expect(after).toBeUndefined();
        return [first];
      }
      if (calls === 2) {
        expect(after).toBeUndefined();
        return [arrival];
      }
      expect(after?.id).toBe(first.id);
      return [older];
    },
  });
  expect(await scan(1)).toEqual([]);
  clock = DOCUMENT_SCAN_REPROBE_MS;
  expect((await scan(1)).map(({ id }) => id)).toEqual([arrival.id]);
  expect((await scan(1)).map(({ id }) => id)).toEqual([older.id]);
});

test("a crash mid-buffer replays unclaimed rows from the newest boundary", async () => {
  const rows = [candidate(true), candidate(true), candidate(true)];
  const claimed = new Set<string>();
  const loadPage = async () =>
    rows.map((row) => ({ ...row, ready: !claimed.has(row.id) }));
  const firstProcess = createRemainingDocumentScan({ loadPage, now: () => 0 });
  const buffered = await firstProcess(3);
  const processed = buffered.at(0);
  expect(processed).toBeDefined();
  if (processed) {
    claimed.add(processed.id);
  }
  const restarted = createRemainingDocumentScan({ loadPage, now: () => 0 });
  expect((await restarted(3)).map(({ id }) => id)).toEqual(
    rows.slice(1).map(({ id }) => id),
  );
});
