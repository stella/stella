import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { isFileProperty } from "@stll/api-contract/property-policy";
import { assertProperty } from "@stll/property-testing";

import { propertyAiCellState } from "@/components/workspaces/ai-cell-state.logic";
import {
  aiColumnRunMenu,
  aiColumnRunScope,
} from "@/components/workspaces/ai-column-run.logic";
import { toSafeId } from "@/lib/safe-id";

import {
  canEditPropertyViaComposer,
  getEntityIdsOrderFromRows,
  getPropertyRunTargetIds,
} from "./property-popover.logic";

const propertyId = toSafeId<"property">("ai-property");
const propertyRunRow = (
  entityId: string,
  content:
    | { type: "error" | "pending" }
    | { type: "text"; value: string }
    | null,
  options: {
    kind?: "document" | "folder";
    locked?: boolean;
    readOnly?: boolean;
  } = {},
) => {
  const safeEntityId = toSafeId<"entity">(entityId);
  return {
    original: {
      cellMetadata:
        options.locked === true
          ? {
              [propertyId]: {
                version: 1 as const,
                manualFlags: [],
                locked: true,
              },
            }
          : {},
      entityId: safeEntityId,
      fields:
        content === null
          ? {}
          : {
              [propertyId]: {
                content:
                  content.type === "text"
                    ? { ...content, version: 1 as const }
                    : { ...content, version: 1 as const },
                entityId: safeEntityId,
                id: toSafeId<"field">(`${entityId}-field`),
                propertyId,
              },
            },
      kind: options.kind ?? "document",
      readOnly: options.readOnly ?? false,
    },
  } satisfies Parameters<typeof getPropertyRunTargetIds>[0]["rows"][number];
};

test("property composer classification follows the shared file policy", () => {
  assertProperty(
    "property composer classification follows the shared file policy",
    fc.property(fc.oneof(fc.constant("file"), fc.string()), (type) => {
      const content = { type };
      expect(isFileProperty(content)).toBe(type === "file");
      expect(canEditPropertyViaComposer(content, false)).toBe(
        !isFileProperty(content),
      );
      expect(canEditPropertyViaComposer(content, true)).toBe(false);
    }),
  );
});

describe("property popover workflow ordering", () => {
  test("reads entity order only from the active table rows", () => {
    const order = getEntityIdsOrderFromRows([
      { original: { entityId: "visible-1" } },
      { original: { entityId: "visible-2" } },
    ]);

    expect(order).toEqual(["visible-1", "visible-2"]);
  });

  test("deduplicates active rows without reading unrelated caches", () => {
    const order = getEntityIdsOrderFromRows([
      { original: { entityId: "visible-1" } },
      { original: { entityId: "visible-1" } },
      { original: { entityId: "visible-2" } },
    ]);

    expect(order).toEqual(["visible-1", "visible-2"]);
  });
});

test("column targets retry missing and failed cells without repeating active or locked rows", () => {
  const rows = [
    propertyRunRow("not-run", null),
    propertyRunRow("failed", { type: "error" }),
    propertyRunRow("running", { type: "pending" }),
    propertyRunRow("done", { type: "text", value: "answer" }),
    propertyRunRow("locked", null, { locked: true }),
    propertyRunRow("read-only", null, { readOnly: true }),
    propertyRunRow("folder", null, { kind: "folder" }),
  ];

  expect(
    getPropertyRunTargetIds({ action: "remaining", propertyId, rows }),
  ).toEqual(["not-run", "failed"]);
  expect(
    getPropertyRunTargetIds({ action: "rerun", propertyId, rows }),
  ).toEqual(["not-run", "failed", "done"]);
});

test("the header reruns a selected column when every selected cell is answered", () => {
  const rows = [propertyRunRow("answered", { type: "text", value: "answer" })];
  const scope = aiColumnRunScope({
    pageRowIds: ["answered"],
    selectedRowIds: ["answered"],
  });
  const action = aiColumnRunMenu(
    rows.map((row) =>
      propertyAiCellState(row.original.fields[propertyId]?.content),
    ),
  ).at(0);
  if (action === undefined) {
    throw new Error("Expected a column run action for an answered cell");
  }

  expect(action.type).toBe("rerun");
  expect(
    getPropertyRunTargetIds({
      action: action.type,
      propertyId,
      rowIds: scope.rowIds,
      rows,
    }),
  ).toEqual(["answered"]);
});
