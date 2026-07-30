import { describe, expect, test } from "bun:test";

import {
  resolveFileFieldPropertyId,
  shouldCloseFileTabAfterSync,
  shouldReplaceFileFieldAfterSync,
} from "@/components/inspector/inspector-panel.logic";

describe("resolveFileFieldPropertyId", () => {
  test("retains the property identity after the active version field disappears", () => {
    const currentFileFieldIdsByProperty = new Map([
      ["property-1", "deleted-field"],
    ]);

    expect(
      resolveFileFieldPropertyId({
        activeFilePropertyId: undefined,
        currentFileFieldIdsByProperty,
        fieldId: "deleted-field",
        tabPropertyId: undefined,
      }),
    ).toBe("property-1");
  });

  test("derives the property from the active field before it is remembered", () => {
    expect(
      resolveFileFieldPropertyId({
        activeFilePropertyId: "property-2",
        currentFileFieldIdsByProperty: new Map(),
        fieldId: "field-2",
        tabPropertyId: undefined,
      }),
    ).toBe("property-2");
  });

  test("prefers the property already stored on the tab", () => {
    expect(
      resolveFileFieldPropertyId({
        activeFilePropertyId: "property-active",
        currentFileFieldIdsByProperty: new Map([
          ["property-remembered", "field-3"],
        ]),
        fieldId: "field-3",
        tabPropertyId: "property-tab",
      }),
    ).toBe("property-tab");
  });
});

describe("shouldReplaceFileFieldAfterSync", () => {
  test("switches away from a deleted historical version", () => {
    expect(
      shouldReplaceFileFieldAfterSync({
        isSelectedFieldMissing: true,
        previousCurrentFieldId: "current-field",
        selectedFieldId: "deleted-historical-field",
      }),
    ).toBe(true);
  });

  test("keeps a historical version that still exists", () => {
    expect(
      shouldReplaceFileFieldAfterSync({
        isSelectedFieldMissing: false,
        previousCurrentFieldId: "current-field",
        selectedFieldId: "historical-field",
      }),
    ).toBe(false);
  });
});

describe("shouldCloseFileTabAfterSync", () => {
  test("closes a deleted restored version when its property cannot be recovered", () => {
    expect(
      shouldCloseFileTabAfterSync({
        filePropertyId: undefined,
        isSelectedFieldMissing: true,
      }),
    ).toBe(true);
  });

  test("keeps a missing historical version when its current property can replace it", () => {
    expect(
      shouldCloseFileTabAfterSync({
        filePropertyId: "property-1",
        isSelectedFieldMissing: true,
      }),
    ).toBe(false);
  });
});
