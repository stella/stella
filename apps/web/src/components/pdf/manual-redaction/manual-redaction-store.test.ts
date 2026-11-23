import { beforeEach, expect, test } from "bun:test";

import {
  readManualRedactionExport,
  useManualRedactionStore,
} from "@/components/pdf/manual-redaction/manual-redaction-store";
import type { ManualRedactionArea } from "@/lib/pdf/manual-redaction.logic";

const FIELD = "field-a";

const area = (id: string): ManualRedactionArea => ({
  id,
  pageIndex: 0,
  left: 0.1,
  top: 0.1,
  right: 0.5,
  bottom: 0.2,
  pageWidth: 595,
  pageHeight: 842,
});

const add = (documentKey: string, id: string) =>
  useManualRedactionStore.getState().dispatch({
    fieldId: FIELD,
    documentKey,
    action: { type: "add", area: area(id) },
  });

beforeEach(() => {
  useManualRedactionStore.setState({ byFieldId: {} });
});

test("areas export with the document they were drawn on", () => {
  expect(readManualRedactionExport(FIELD)).toBeNull();
  useManualRedactionStore.getState().bindDocument(FIELD, "doc-1");
  expect(readManualRedactionExport(FIELD)).toBeNull();
  add("doc-1", "a");
  expect(readManualRedactionExport(FIELD)).toEqual({
    documentKey: "doc-1",
    areas: [area("a")],
  });
});

test("another document drops the areas and the marking mode", () => {
  const state = useManualRedactionStore.getState();
  state.bindDocument(FIELD, "doc-1");
  add("doc-1", "a");
  state.setMode(FIELD, "drawing");
  // The same document again (another page mounting) keeps everything.
  state.bindDocument(FIELD, "doc-1");
  expect(useManualRedactionStore.getState().byFieldId[FIELD]?.areas).toEqual([
    area("a"),
  ]);

  state.bindDocument(FIELD, "doc-2");
  expect(useManualRedactionStore.getState().byFieldId[FIELD]).toEqual({
    documentKey: "doc-2",
    areas: [],
    mode: "viewing",
  });
  expect(readManualRedactionExport(FIELD)).toBeNull();
});

test("a drag that finishes after the document changed adds nothing", () => {
  const state = useManualRedactionStore.getState();
  state.bindDocument(FIELD, "doc-1");
  state.bindDocument(FIELD, "doc-2");
  add("doc-1", "late");
  expect(readManualRedactionExport(FIELD)).toBeNull();
});

test("removing the last area leaves nothing to export", () => {
  const state = useManualRedactionStore.getState();
  state.bindDocument(FIELD, "doc-1");
  add("doc-1", "a");
  state.dispatch({
    fieldId: FIELD,
    documentKey: "doc-1",
    action: { type: "remove", id: "a" },
  });
  expect(readManualRedactionExport(FIELD)).toBeNull();
});

test("the marking mode belongs to a bound document only", () => {
  const state = useManualRedactionStore.getState();
  state.setMode(FIELD, "drawing");
  expect(useManualRedactionStore.getState().byFieldId[FIELD]).toBeUndefined();
  state.bindDocument(FIELD, "doc-1");
  state.setMode(FIELD, "drawing");
  expect(useManualRedactionStore.getState().byFieldId[FIELD]?.mode).toBe(
    "drawing",
  );
});
