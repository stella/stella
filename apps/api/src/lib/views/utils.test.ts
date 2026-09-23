import { describe, expect, test } from "bun:test";

import { VIEW_LAYOUT_TYPES } from "@stll/api-contract";

import { toSafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";
import { convertLayout, portableLayout } from "@/api/lib/views/utils";

const base = {
  version: 1,
  filters: [],
  sorts: [{ propertyId: "_created-at", desc: true }],
  hiddenProperties: ["hidden"],
  calculations: [],
} satisfies Omit<Extract<ViewLayout, { type: "overview" }>, "type">;

const listId = toSafeId<"legalList">("0199a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b");

const avtLayout: ViewLayout = { ...base, type: "avt", listId };

describe("layouts carried out of their matter", () => {
  test("an AVT layout forgets the list it was bound to", () => {
    expect(portableLayout(avtLayout)).toEqual({ ...avtLayout, listId: null });
  });

  test("every other layout is carried unchanged", () => {
    for (const type of VIEW_LAYOUT_TYPES) {
      if (type === "avt") {
        continue;
      }
      const layout = convertLayout(avtLayout, type);
      expect(portableLayout(layout)).toBe(layout);
    }
  });
});

describe("converting to an AVT layout", () => {
  test("keeps the filters, sorts and hidden columns, with no list yet", () => {
    const table: ViewLayout = {
      ...base,
      type: "table",
      columnOrder: [],
      columnPinning: [],
    };

    expect(convertLayout(table, "avt")).toEqual({
      ...base,
      type: "avt",
      listId: null,
    });
  });
});
