import { expect, test } from "bun:test";
import fc from "fast-check";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import { assertProperty } from "@stll/property-testing";

import type { InspectorTabsStore } from "./inspector-store-types";
import { createInspectorTabsSlice } from "./inspector-tabs-slice";

test("file metadata updates are atomic and preserve field identity", () => {
  assertProperty(
    "file metadata updates are atomic and preserve field identity",
    fc.property(fc.string(), fc.string(), (label, fileName) => {
      const store = createStore<InspectorTabsStore>()(
        immer((set, get) => createInspectorTabsSlice(set, get)),
      );
      store.getState().openFile({
        id: "field",
        entityId: "entity",
        workspaceId: "matter",
        label: "previous.md",
        fileName: "previous.md",
        pdfFileId: null,
      });
      const before = store.getState().tabs.at(0);
      if (before?.type !== "pdf") {
        throw new Error("Expected the opened file tab");
      }
      const observations: unknown[] = [];
      const unsubscribe = store.subscribe((state) => {
        observations.push(state.tabs.at(0));
      });
      store.getState().updateFileMetadata("field", { label, fileName });
      expect(store.getState().tabs.at(0)).toEqual({
        ...before,
        label,
        fileName,
      });
      expect(observations.length).toBeLessThanOrEqual(1);
      for (const observed of observations) {
        expect(observed).toEqual({ ...before, label, fileName });
      }
      const confirmed = store.getState();
      store.getState().updateFileMetadata("closed-field", { label, fileName });
      expect(store.getState()).toBe(confirmed);
      unsubscribe();
    }),
    { numRuns: 100 },
  );
});

test("renamed file metadata keeps only supported attachment facets", () => {
  assertProperty(
    "renamed file metadata keeps only supported attachment facets",
    fc.property(
      fc.constantFrom("eml", "msg", "md", "pdf"),
      fc.constantFrom(undefined, "application/octet-stream", "message/rfc822"),
      (extension, mimeType) => {
        const store = createStore<InspectorTabsStore>()(
          immer((set, get) => createInspectorTabsSlice(set, get)),
        );
        store.getState().openFile({
          id: "field",
          entityId: "entity",
          workspaceId: "matter",
          label: "previous.eml",
          fileName: "previous.eml",
          mimeType,
          pdfFileId: null,
        });
        store.getState().setFileFacet("field", "attachments");
        expect(store.getState().tabs.at(0)).toMatchObject({
          type: "pdf",
          facet: "attachments",
        });
        const observations: unknown[] = [];
        const unsubscribe = store.subscribe((state) => {
          observations.push(state.tabs.at(0));
        });
        const label = `updated.${extension}`;
        store
          .getState()
          .updateFileMetadata("field", { label, fileName: label });
        const expectedFacet =
          mimeType === "message/rfc822" ||
          extension === "eml" ||
          extension === "msg"
            ? "attachments"
            : "preview";
        expect(store.getState().tabs.at(0)).toMatchObject({
          id: "field",
          label,
          fileName: label,
          facet: expectedFacet,
        });
        expect(observations).toHaveLength(1);
        expect(observations.at(0)).toMatchObject({
          label,
          fileName: label,
          facet: expectedFacet,
        });
        unsubscribe();
      },
    ),
    { numRuns: 100 },
  );
});
