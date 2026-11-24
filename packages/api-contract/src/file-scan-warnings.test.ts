import { describe, expect, test } from "bun:test";

import {
  knownUnscannedContentReasons,
  UNSCANNED_CONTENT_REASONS,
  UNSCANNED_CONTENT_WARNING,
  unscannedContentReasons,
} from "./file-scan-warnings";

describe("unscannedContentReasons", () => {
  test("reads each reason from its stored warning, in a fixed order", () => {
    expect(
      unscannedContentReasons([
        "Embedded PE/MZ executable signature found",
        UNSCANNED_CONTENT_WARNING.unsupportedCompression,
        UNSCANNED_CONTENT_WARNING.encrypted,
      ]),
    ).toEqual(["encrypted", "unsupportedCompression"]);
  });

  test("finds nothing in other warnings or in none", () => {
    expect(unscannedContentReasons(null)).toEqual([]);
    expect(unscannedContentReasons(undefined)).toEqual([]);
    expect(unscannedContentReasons([])).toEqual([]);
    expect(
      unscannedContentReasons(["OLE2 compound file container detected"]),
    ).toEqual([]);
  });

  test("gives every reason a warning of its own", () => {
    const warnings = UNSCANNED_CONTENT_REASONS.map(
      (reason) => UNSCANNED_CONTENT_WARNING[reason],
    );

    expect(new Set(warnings).size).toBe(UNSCANNED_CONTENT_REASONS.length);
    for (const reason of UNSCANNED_CONTENT_REASONS) {
      expect(
        unscannedContentReasons([UNSCANNED_CONTENT_WARNING[reason]]),
      ).toEqual([reason]);
    }
  });
});

describe("knownUnscannedContentReasons", () => {
  test("keeps the reasons this client knows, in the fixed order", () => {
    expect(
      knownUnscannedContentReasons([
        "unsupportedCompression",
        "aNewerReason",
        "encrypted",
      ]),
    ).toEqual(["encrypted", "unsupportedCompression"]);
  });

  test("reads nothing from a value that is not a list", () => {
    expect(knownUnscannedContentReasons(undefined)).toEqual([]);
    expect(knownUnscannedContentReasons("encrypted")).toEqual([]);
    expect(knownUnscannedContentReasons({ encrypted: true })).toEqual([]);
  });
});
