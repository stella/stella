import { describe, expect, test } from "bun:test";

import {
  columnTrimGate,
  corpusObjectState,
  parseColumnTrimArgs,
  planColumnTrim,
} from "@/api/scripts/corpus-column-trim-plan";

describe("corpusObjectState", () => {
  test("a recorded key is only verified once the object is found", () => {
    expect(corpusObjectState({ key: "k", exists: true })).toBe("verified");
    expect(corpusObjectState({ key: "k", exists: false })).toBe(
      "object-missing",
    );
  });

  test("a missing key is never verified, whatever the bucket says", () => {
    expect(corpusObjectState({ key: null, exists: true })).toBe("key-missing");
  });
});

describe("planColumnTrim", () => {
  test("trims only when all three objects are verified", () => {
    expect(
      planColumnTrim({
        text: "verified",
        sections: "verified",
        ast: "verified",
      }),
    ).toEqual({ type: "trim" });
  });

  test("one unverified object blocks the trim", () => {
    for (const [text, sections, ast] of [
      ["object-missing", "verified", "verified"],
      ["verified", "object-missing", "verified"],
      ["verified", "verified", "object-missing"],
      ["verified", "key-missing", "verified"],
      ["verified", "verified", "key-missing"],
      ["key-missing", "key-missing", "key-missing"],
    ] as const) {
      expect(planColumnTrim({ text, sections, ast }).type).toBe("skip");
    }
  });

  test("the skip reason names every object's state", () => {
    const decision = planColumnTrim({
      text: "verified",
      sections: "object-missing",
      ast: "verified",
    });
    if (decision.type !== "skip") {
      throw new Error("expected a skip");
    }
    expect(decision.reason).toBe(
      "text=verified sections=object-missing ast=verified",
    );
  });
});

describe("columnTrimGate", () => {
  test("only canonical mode may trim without --force", () => {
    expect(columnTrimGate({ mode: "canonical", force: false }).type).toBe(
      "allowed",
    );
    expect(columnTrimGate({ mode: "dual-write", force: false }).type).toBe(
      "refused",
    );
    expect(columnTrimGate({ mode: "off", force: false }).type).toBe("refused");
  });

  test("--force overrides the refusal", () => {
    expect(columnTrimGate({ mode: "off", force: true }).type).toBe("allowed");
  });
});

describe("parseColumnTrimArgs", () => {
  test("defaults to an uncapped, mutating, gated run", () => {
    expect(parseColumnTrimArgs([])).toEqual({
      type: "parsed",
      args: { limit: null, dryRun: false, force: false },
    });
  });

  test("accepts both --limit forms alongside the flags", () => {
    expect(parseColumnTrimArgs(["--limit", "25", "--dry-run"])).toEqual({
      type: "parsed",
      args: { limit: 25, dryRun: true, force: false },
    });
    expect(parseColumnTrimArgs(["--limit=25", "--force"])).toEqual({
      type: "parsed",
      args: { limit: 25, dryRun: false, force: true },
    });
  });

  test("rejects a non-positive, non-numeric, or absent limit", () => {
    for (const argv of [
      ["--limit"],
      ["--limit", "0"],
      ["--limit", "-3"],
      ["--limit", "abc"],
      ["--limit", "--dry-run"],
    ]) {
      expect(parseColumnTrimArgs(argv).type).toBe("invalid");
    }
  });

  test("rejects an unknown flag instead of ignoring it", () => {
    expect(parseColumnTrimArgs(["--wipe"]).type).toBe("invalid");
  });
});
