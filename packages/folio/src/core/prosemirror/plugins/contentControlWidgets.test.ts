/**
 * Smoke tests for the content-control widgets plugin.
 *
 * The plugin's primary side-effect is dispatching transactions when the
 * user clicks inside a typed control. We exercise the helper functions
 * directly here (the click handler runs through the same code path) and
 * defer end-to-end DOM tests to Playwright.
 */

import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema, singletonManager } from "../schema";
import {
  dispatchDatePick,
  dispatchDropdownPick,
} from "./contentControlWidgets";

type StubView = Pick<EditorView, "state" | "dispatch">;

function viewLike(stateRef: { state: EditorState }): StubView {
  return {
    state: stateRef.state,
    dispatch(tr) {
      stateRef.state = stateRef.state.apply(tr);
    },
  };
}

describe("dispatchDropdownPick", () => {
  test("writes the picked value as the displayText", () => {
    const sdt = schema.node(
      "blockSdt",
      {
        sdtType: "dropdown",
        tag: "state",
        listItems: JSON.stringify([
          { value: "ca", displayText: "California" },
          { value: "ny", displayText: "New York" },
        ]),
      },
      [schema.node("paragraph", {}, [schema.text("☐")])],
    );
    const initial = EditorState.create({
      doc: schema.node("doc", null, [sdt]),
      schema,
      plugins: [...singletonManager.getPlugins()],
    });
    const ref = { state: initial };
    // The helper expects an `EditorView`; only `state` and `dispatch` are
    // touched here, so a structural stub satisfies the contract. The PM
    // position of the SDT is 0 (it is the doc's first child).
    const ok = dispatchDropdownPick(viewLike(ref) as EditorView, 0, "ny");
    expect(ok).toBe(true);
    expect(ref.state.doc.firstChild?.firstChild?.textContent).toBe("New York");
  });
});

describe("dispatchDropdownPick — lock handling", () => {
  test("returns false instead of throwing when the picked control is locked", () => {
    // The click-time preflight should have caught this, but the doc could
    // have changed mid-picker. The dispatch helper must not let a
    // ContentControlLockedError escape into the React handler — that
    // would surface as an uncaught UI error and crash the picker shell.
    const sdt = schema.node(
      "blockSdt",
      {
        sdtType: "dropdown",
        tag: "state",
        lock: "contentLocked",
        listItems: JSON.stringify([{ value: "ca", displayText: "California" }]),
      },
      [schema.node("paragraph", {}, [schema.text("☐")])],
    );
    const initial = EditorState.create({
      doc: schema.node("doc", null, [sdt]),
      schema,
      plugins: [...singletonManager.getPlugins()],
    });
    const ref = { state: initial };
    expect(() =>
      dispatchDropdownPick(viewLike(ref) as EditorView, 0, "ca"),
    ).not.toThrow();
    expect(dispatchDropdownPick(viewLike(ref) as EditorView, 0, "ca")).toBe(
      false,
    );
  });
});

describe("dispatchDatePick", () => {
  test("returns false instead of throwing when the picked control is locked", () => {
    const sdt = schema.node(
      "blockSdt",
      {
        sdtType: "date",
        tag: "effective",
        lock: "sdtContentLocked",
      },
      [schema.node("paragraph", {}, [])],
    );
    const initial = EditorState.create({
      doc: schema.node("doc", null, [sdt]),
      schema,
      plugins: [...singletonManager.getPlugins()],
    });
    const ref = { state: initial };
    expect(() =>
      dispatchDatePick(viewLike(ref) as EditorView, 0, "2026-06-02"),
    ).not.toThrow();
    expect(dispatchDatePick(viewLike(ref) as EditorView, 0, "2026-06-02")).toBe(
      false,
    );
  });

  test("writes the picked date into the control body", () => {
    const sdt = schema.node("blockSdt", { sdtType: "date", tag: "effective" }, [
      schema.node("paragraph", {}, []),
    ]);
    const initial = EditorState.create({
      doc: schema.node("doc", null, [sdt]),
      schema,
      plugins: [...singletonManager.getPlugins()],
    });
    const ref = { state: initial };
    const ok = dispatchDatePick(viewLike(ref) as EditorView, 0, "2026-06-02");
    expect(ok).toBe(true);
    expect(ref.state.doc.firstChild?.firstChild?.textContent).toBe(
      "2026-06-02",
    );
  });
});
