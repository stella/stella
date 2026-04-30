import { describe, expect, test } from "bun:test";

import { parseViewLayout } from "@/api/lib/views-schema";
import type { ViewLayout } from "@/api/lib/views-schema";

describe("parseViewLayout", () => {
  test("keeps versioned layouts unchanged", () => {
    const layout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: [],
    } satisfies ViewLayout;

    expect(parseViewLayout(layout)).toEqual(layout);
  });

  test("rejects unversioned layouts", () => {
    const layout = {
      type: "calendar",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      datePropertyId: "_created-at",
      mode: "month",
    };

    expect(() => parseViewLayout(layout)).toThrow();
  });
});
