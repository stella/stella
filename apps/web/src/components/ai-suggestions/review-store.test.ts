/**
 * Tests for the pure helpers in `review-store.ts` — the panel's
 * filter rules (autohide accepted + severity/area dropdown) and
 * the initials computation used by the identity popover avatar.
 */

import { describe, expect, test } from "bun:test";

import {
  computeInitialsFrom,
  filterReviewSuggestions,
  findLiveSuggestion,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";

const stub = (
  id: string,
  status: ReviewSuggestion["status"],
  overrides: Partial<ReviewSuggestion> = {},
): ReviewSuggestion => ({
  id,
  blockId: "b-001",
  type: "replaceInBlock",
  summary: id,
  preview: {
    type: "replaceInBlock",
    contextBefore: "",
    before: "x",
    after: "y",
    contextAfter: "",
  },
  severity: "low",
  area: "Spelling",
  status,
  applyMode: null,
  revisionIds: null,
  undoHandle: null,
  pendingOperation: null,
  snapshot: null,
  ...overrides,
});

describe("filterReviewSuggestions", () => {
  test("returns all items when no filter is set and hideAccepted is off", () => {
    const items = [
      stub("s1", "pending"),
      stub("s2", "accepted"),
      stub("s3", "rejected"),
      stub("s4", "skipped"),
      stub("s5", "applying"),
    ];
    const out = filterReviewSuggestions(items, {
      hideAccepted: false,
      filter: null,
      groupAxis: "severity",
    });
    expect(out).toHaveLength(5);
  });

  test("hideAccepted keeps pending and applying, drops the rest", () => {
    // The "applying" status must survive the filter so the loading
    // indicator doesn't disappear mid-Accept-click.
    const items = [
      stub("s1", "pending"),
      stub("s2", "accepted"),
      stub("s3", "rejected"),
      stub("s4", "skipped"),
      stub("s5", "applying"),
    ];
    const out = filterReviewSuggestions(items, {
      hideAccepted: true,
      filter: null,
      groupAxis: "severity",
    });
    expect(out.map((i) => i.id)).toEqual(["s1", "s5"]);
  });

  test("filter on severity keeps only matching severity", () => {
    const items = [
      stub("s1", "pending", { severity: "high" }),
      stub("s2", "pending", { severity: "low" }),
      stub("s3", "pending", { severity: "high" }),
    ];
    const out = filterReviewSuggestions(items, {
      hideAccepted: false,
      filter: "high",
      groupAxis: "severity",
    });
    expect(out.map((i) => i.id)).toEqual(["s1", "s3"]);
  });

  test("filter on area keeps only matching area when groupAxis is area", () => {
    const items = [
      stub("s1", "pending", { area: "Spelling" }),
      stub("s2", "pending", { area: "Names" }),
      stub("s3", "pending", { area: "Names" }),
    ];
    const out = filterReviewSuggestions(items, {
      hideAccepted: false,
      filter: "Names",
      groupAxis: "area",
    });
    expect(out.map((i) => i.id)).toEqual(["s2", "s3"]);
  });

  test("hideAccepted and severity filter compose (intersection)", () => {
    const items = [
      stub("s1", "pending", { severity: "high" }),
      stub("s2", "accepted", { severity: "high" }),
      stub("s3", "pending", { severity: "low" }),
    ];
    const out = filterReviewSuggestions(items, {
      hideAccepted: true,
      filter: "high",
      groupAxis: "severity",
    });
    expect(out.map((i) => i.id)).toEqual(["s1"]);
  });
});

describe("findLiveSuggestion", () => {
  const withOp = (id: string, opId: string): ReviewSuggestion =>
    stub(id, "applying", {
      pendingOperation: {
        type: "replaceInBlock",
        id: opId,
        blockId: "b-001",
        find: "x",
        replace: "y",
      },
    });

  test("returns undefined when the session is undefined", () => {
    expect(findLiveSuggestion(undefined, "s1")).toBeUndefined();
  });

  test("fast path: matches the row still under the captured id", () => {
    const session = [
      withOp("client-1", "client-1"),
      withOp("client-2", "client-2"),
    ];
    expect(findLiveSuggestion(session, "client-1")?.id).toBe("client-1");
  });

  test("follows a reconcile rename via the stable pendingOperation.id", () => {
    // After reconcileServerIds the top-level id is the server id, but the
    // folio op keeps the original client ref — an accept that captured the
    // client ref before the persist landed must still find the row.
    const reconciled = stub("server-1", "applying", {
      persisted: true,
      pendingOperation: {
        type: "replaceInBlock",
        id: "client-1",
        blockId: "b-001",
        find: "x",
        replace: "y",
      },
    });
    const found = findLiveSuggestion([reconciled], "client-1");
    expect(found?.id).toBe("server-1");
    expect(found?.persisted).toBe(true);
  });

  test("prefers the direct id match over the op-ref match", () => {
    // A row whose op ref equals another row's current id must not shadow the
    // direct hit.
    const direct = withOp("shared", "op-a");
    const opRefCollision = withOp("other", "shared");
    const found = findLiveSuggestion([opRefCollision, direct], "shared");
    expect(found?.id).toBe("shared");
  });

  test("returns undefined when neither id nor op ref matches", () => {
    expect(findLiveSuggestion([withOp("a", "a")], "missing")).toBeUndefined();
  });
});

describe("reconcileServerIds preserves the op ref", () => {
  test("renames the top-level id but keeps pendingOperation.id as the client ref", () => {
    const entityId = "entity-reconcile-op-ref";
    const client = stub("client-1", "applying", {
      pendingOperation: {
        type: "replaceInBlock",
        id: "client-1",
        blockId: "b-001",
        find: "x",
        replace: "y",
      },
    });
    useReviewStore.getState().appendSuggestions(entityId, [client]);
    useReviewStore
      .getState()
      .reconcileServerIds(entityId, { "client-1": "server-1" });

    const row = useReviewStore.getState().sessions[entityId]?.at(0);
    expect(row?.id).toBe("server-1");
    expect(row?.persisted).toBe(true);
    // The invariant findLiveSuggestion relies on: the op ref survives the
    // rename, so an in-flight accept can still follow the row.
    expect(row?.pendingOperation?.id).toBe("client-1");

    useReviewStore.getState().resetSession(entityId);
  });
});

describe("computeInitialsFrom", () => {
  test("empty input gives empty initials", () => {
    expect(computeInitialsFrom("")).toBe("");
    expect(computeInitialsFrom("   ")).toBe("");
  });

  test("single name returns its first letter uppercased", () => {
    expect(computeInitialsFrom("jan")).toBe("J");
    expect(computeInitialsFrom("Jan")).toBe("J");
  });

  test("multiple words return one letter each, max 3, all uppercase", () => {
    expect(computeInitialsFrom("Jan Kubica")).toBe("JK");
    expect(computeInitialsFrom("jan ondřej kubica")).toBe("JOK");
    expect(computeInitialsFrom("a b c d e")).toBe("ABC"); // capped at 3
  });

  test("respects locale-aware uppercasing for non-Latin scripts", () => {
    // The first character of "ščasná" should uppercase as "Š".
    expect(computeInitialsFrom("ščasná")).toBe("Š");
    expect(computeInitialsFrom("česky šťastný")).toBe("ČŠ");
  });

  test("collapses repeated whitespace correctly", () => {
    expect(computeInitialsFrom("  Jan   Kubica   ")).toBe("JK");
  });
});
