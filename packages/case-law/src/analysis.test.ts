import { describe, expect, test } from "bun:test";

import { parsePersistedDecisionAnalysis } from "./analysis";

describe("parsePersistedDecisionAnalysis", () => {
  test("keeps versioned generating analysis payloads", () => {
    const analysis = {
      version: 1,
      status: "generating",
      startedAt: "2026-04-30T12:00:00.000Z",
    } as const;

    expect(parsePersistedDecisionAnalysis(analysis)).toEqual(analysis);
  });

  test("rejects unversioned generating sentinels", () => {
    expect(
      parsePersistedDecisionAnalysis({
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
      }),
    ).toBeNull();
  });
});
