import { describe, expect, test } from "bun:test";

import { runHistoryOptions } from "@/features/avt/run-history.logic";
import type { VerificationRunSummary } from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";

const uuid = (suffix: number) =>
  `0199a3c4-5b6d-7e8f-9a0b-${String(suffix).padStart(12, "0")}`;

const LIST_A = toSafeId<"legalList">(uuid(1));
const LIST_B = toSafeId<"legalList">(uuid(2));

const COUNTS = {
  supported: 5,
  tension: 8,
  contradicted: 2,
  nocover: 9,
  notverifiable: 7,
  recordconflict: 3,
};

const makeRun = (
  suffix: number,
  overrides: Partial<VerificationRunSummary> = {},
): VerificationRunSummary => ({
  id: toSafeId<"legalListVerificationRun">(uuid(100 + suffix)),
  entityId: toSafeId<"entity">(uuid(10)),
  fileFieldId: toSafeId<"field">(uuid(11)),
  status: "completed",
  errorCode: null,
  entityVersionId: toSafeId<"entityVersion">(uuid(12)),
  listId: LIST_A,
  createdAt: `2026-09-2${String(suffix)}T10:00:00.000Z`,
  finishedAt: `2026-09-2${String(suffix)}T10:05:00.000Z`,
  claimCounts: COUNTS,
  ...overrides,
});

describe("run picker options", () => {
  test("a repeated page-edge run keeps the first page's settled result", () => {
    const settled = makeRun(1);
    const stale = { ...settled, status: "running", finishedAt: null } as const;
    expect(runHistoryOptions([settled, stale], LIST_A)).toEqual([
      {
        id: settled.id,
        status: "completed",
        createdAtMs: Date.UTC(2026, 8, 21, 10),
        claimCounts: COUNTS,
        otherList: false,
      },
    ]);
  });

  test("queued runs hide counts and dates retain their timezone offset", () => {
    const queued = makeRun(1, {
      status: "queued",
      finishedAt: null,
      createdAt: "2026-09-21T12:00:00.125+02:00",
    });
    const option = runHistoryOptions([queued], LIST_A).at(0);
    expect(option?.claimCounts).toBeNull();
    expect(option?.createdAtMs).toBe(Date.UTC(2026, 8, 21, 10, 0, 0, 125));
  });

  test("marks a run checked against a list other than the view's", () => {
    const runs = [makeRun(1), makeRun(2, { listId: LIST_B })];

    expect(
      runHistoryOptions(runs, LIST_A).map((option) => option.otherList),
    ).toEqual([false, true]);
  });

  test("marks nothing while the view has no list to compare with", () => {
    const runs = [makeRun(1), makeRun(2, { listId: LIST_B })];

    expect(
      runHistoryOptions(runs, null).map((option) => option.otherList),
    ).toEqual([false, false]);
  });

  test("summarises claims only for a completed run", () => {
    const runs = [
      makeRun(1, { status: "running", finishedAt: null }),
      makeRun(2, { status: "failed", errorCode: "no_text" }),
      makeRun(3),
    ];

    expect(
      runHistoryOptions(runs, LIST_A).map((option) => option.claimCounts),
    ).toEqual([null, null, COUNTS]);
  });

  test("keeps each run once, in the order the history lists them", () => {
    const [first, second, third] = [makeRun(3), makeRun(2), makeRun(1)];
    const options = runHistoryOptions([first, second, second, third], LIST_A);

    expect(options.map((option) => option.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(options[0]?.createdAtMs).toBe(Date.UTC(2026, 8, 23, 10));
  });
});
