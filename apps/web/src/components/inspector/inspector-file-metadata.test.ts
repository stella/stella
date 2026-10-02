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
        immer((set) => createInspectorTabsSlice(set)),
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
