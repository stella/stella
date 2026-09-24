import { describe, expect, test } from "bun:test";

import "@/components/inspector/inspector-persistence-references";
import { getInspectorPersistenceReference } from "@/components/inspector/view-registry";
import {
  createStatuteViewTab,
  STATUTE_VIEW,
} from "@/features/statutes/statute-inspector.logic";

const target = {
  country: "CZE",
  documentId: "0198f4c1-2b3d-7a41-9c88-4a1c0e2f5d6b",
  eli: "/eli/cz/sb/2012/89",
  slug: "89-2012-sb-obcansky-zakonik",
  statuteTitle: "Občanský zákoník",
  versionValidFrom: "2024-01-01",
};

const persistStatute = (payload: unknown): unknown => {
  const reference = getInspectorPersistenceReference(STATUTE_VIEW);
  expect(reference).toBeDefined();
  expect(reference?.validate(payload)).toBe(true);
  const persisted = reference?.project(payload);
  expect(reference?.validate(persisted)).toBe(true);
  return persisted;
};

describe("statute tab persistence", () => {
  test("a reload comes back at the passage the tab was opened at", () => {
    const { payload } = createStatuteViewTab({
      ...target,
      anchorId: "par_2894",
    });

    expect(persistStatute(payload)).toEqual(payload);
  });

  test("a tab opened at the top stays at the top", () => {
    const { payload } = createStatuteViewTab(target);

    expect(persistStatute(payload)).not.toHaveProperty("anchorId");
  });
});
