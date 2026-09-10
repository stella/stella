import { describe, expect, test } from "bun:test";

import type { CompareChange } from "@stll/folio-core";

import type { EntityVersion } from "@/lib/workspaces/queries/entity-versions";

import {
  COMPARE_CHANGE_KIND_LABEL_KEYS,
  countCompareChanges,
  resolveCompareVersionSelection,
} from "./compare-facet.logic";

const version = ({
  id,
  versionNumber,
  fieldId,
  mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}: {
  id: string;
  versionNumber: number;
  fieldId: string;
  mimeType?: string;
}): EntityVersion => ({
  id,
  versionNumber,
  stamp: null,
  label: null,
  description: null,
  diffWordsAdded: null,
  diffWordsRemoved: null,
  createdAt: "2026-09-09T12:00:00.000Z",
  author: null,
  file: {
    fieldId,
    propertyId: "property-1",
    fileName: `v${String(versionNumber)}.docx`,
    mimeType,
    sizeBytes: 1,
  },
});

describe("compare version selection", () => {
  test("defaults to the active DOCX and its immediate predecessor", () => {
    expect(
      resolveCompareVersionSelection({
        currentFieldId: "field-3",
        requested: null,
        versions: [
          version({ id: "v3", versionNumber: 3, fieldId: "field-3" }),
          version({ id: "v1", versionNumber: 1, fieldId: "field-1" }),
          version({ id: "v2", versionNumber: 2, fieldId: "field-2" }),
        ],
      }),
    ).toEqual({ baseVersionId: "v2", targetVersionId: "v3" });
  });

  test("keeps a valid explicit selection and excludes non-DOCX versions", () => {
    expect(
      resolveCompareVersionSelection({
        currentFieldId: "pdf-field",
        requested: { baseVersionId: "v1", targetVersionId: "v3" },
        versions: [
          version({ id: "v1", versionNumber: 1, fieldId: "field-1" }),
          version({
            id: "v2",
            versionNumber: 2,
            fieldId: "pdf-field",
            mimeType: "application/pdf",
          }),
          version({ id: "v3", versionNumber: 3, fieldId: "field-3" }),
        ],
      }),
    ).toEqual({ baseVersionId: "v1", targetVersionId: "v3" });
  });

  test("uses the oldest active version as the base", () => {
    expect(
      resolveCompareVersionSelection({
        currentFieldId: "field-1",
        requested: null,
        versions: [
          version({ id: "v2", versionNumber: 2, fieldId: "field-2" }),
          version({ id: "v1", versionNumber: 1, fieldId: "field-1" }),
        ],
      }),
    ).toEqual({ baseVersionId: "v1", targetVersionId: "v2" });
  });

  test("requires two distinct DOCX versions", () => {
    expect(
      resolveCompareVersionSelection({
        currentFieldId: "field-1",
        requested: null,
        versions: [version({ id: "v1", versionNumber: 1, fieldId: "field-1" })],
      }),
    ).toBeNull();
  });
});

describe("compare change summary", () => {
  test("counts each kind in the canonical presentation order", () => {
    const changes = [
      { kind: "format" },
      { kind: "insert" },
      { kind: "format" },
      { kind: "table-row-delete" },
    ] satisfies readonly Pick<CompareChange, "kind">[];

    expect(countCompareChanges(changes)).toEqual([
      { count: 1, kind: "insert" },
      { count: 2, kind: "format" },
      { count: 1, kind: "table-row-delete" },
    ]);
  });

  test("keeps the label map total over the Folio change union", () => {
    expect(Object.keys(COMPARE_CHANGE_KIND_LABEL_KEYS)).toHaveLength(15);
  });
});
