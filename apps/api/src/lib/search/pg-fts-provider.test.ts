import { describe, expect, test } from "bun:test";

import { HIGHLIGHT_START, HIGHLIGHT_STOP } from "@/api/lib/search/highlight";
import { mapHitRow } from "@/api/lib/search/pg-fts-provider";

const row = (headline: unknown) => ({
  entity_id: "e1",
  headline,
  kind: "document",
  title: "t",
  updated_at: new Date("2026-01-01T00:00:00Z"),
  workspace_id: "w1",
  workspace_name: "W",
});

describe("mapHitRow headline", () => {
  test("escapes and highlights the raw snippet without wrapping it in quotes", () => {
    const hit = mapHitRow(
      row(`He said ${HIGHLIGHT_START}hi${HIGHLIGHT_STOP} to "x" & y`),
    );
    expect(hit.headline).toBe(
      "He said <mark>hi</mark> to &quot;x&quot; &amp; y",
    );
  });

  test("empty or missing headline maps to null", () => {
    expect(mapHitRow(row("")).headline).toBeNull();
    expect(mapHitRow(row(null)).headline).toBeNull();
  });
});
