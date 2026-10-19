import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { EXPANSION_REQUEST } from "@/api/handlers/case-law/decisions/search-expand";
import { TITLE_SERVICE_TIER } from "@/api/handlers/chat/generate-thread-title";

// The role contract replays each structured answer with the harness's own
// request settings, so the settings a production call site sends are pinned
// here: the values, and that the call site sends them.

const API_SRC = path.resolve(import.meta.dir, "..");
const source = (relative: string) =>
  readFileSync(path.join(API_SRC, relative), "utf-8");

// A short structured answer from a fast model took 1.8-2.1 s at the median and
// 3.3-3.9 s at p95 across the offered providers; a deadline below the p95
// drops answers the reader already paid for.
const FAST_STRUCTURED_P95_MS = 3900;

describe("structured-output request settings", () => {
  test("search expansion waits past a fast model's p95 for a short reply", () => {
    expect(EXPANSION_REQUEST.deadlineMs).toBeGreaterThanOrEqual(
      FAST_STRUCTURED_P95_MS,
    );
    expect(EXPANSION_REQUEST.maxOutputTokens).toBe(200);
  });

  test("search expansion sends those settings and no timeout of its own", () => {
    const handler = source("handlers/case-law/decisions/search-expand.ts");
    expect(handler).toContain("...EXPANSION_REQUEST,");
    expect(handler).not.toContain("AbortSignal.timeout(");
    // The constant's own value is the only literal allowance in the file.
    expect(handler.match(/maxOutputTokens:\s*\d/gu)).toHaveLength(1);
  });

  test("titles run on the standard tier for admission and generation", () => {
    expect(TITLE_SERVICE_TIER).toBe("standard");
    const handler = source("handlers/chat/generate-thread-title.ts");
    expect(handler.match(/serviceTier: TITLE_SERVICE_TIER,/gu)).toHaveLength(2);
    expect(handler).not.toMatch(/serviceTier:\s*"/u);
  });
});
