/**
 * Tests for the pure helpers in `review-store.ts` — the panel's
 * filter rules (autohide accepted + severity/area dropdown) and
 * the initials computation used by the identity popover avatar.
 */

import { describe, expect, test } from "bun:test";

import {
  computeInitialsFrom,
  filterReviewSuggestions,
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
