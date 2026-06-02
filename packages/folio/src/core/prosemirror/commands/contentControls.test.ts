/**
 * PM transaction helpers for content controls.
 */

import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import {
  ContentControlLockedError,
  ContentControlTypeError,
} from "../../content-controls";
import { createSuggestionModePlugin } from "../plugins/suggestionMode";
import { schema, singletonManager } from "../schema";
import {
  blockSdtAttrsToSdtProperties,
  findBlockSdtMatch,
  findBlockSdtMatches,
  removeContentControlTr,
  setContentControlContentTr,
  setContentControlValueTr,
} from "./contentControls";

function makeState(docNode = defaultDoc()): EditorState {
  return EditorState.create({
    doc: docNode,
    schema,
    plugins: [...singletonManager.getPlugins()],
  });
}

function defaultDoc() {
  const sdt = schema.node(
    "blockSdt",
    { sdtType: "richText", tag: "name", alias: "Name" },
    [schema.node("paragraph", {}, [schema.text("original")])],
  );
  const tail = schema.node("paragraph", {}, [schema.text("after")]);
  return schema.node("doc", null, [sdt, tail]);
}

describe("findBlockSdtMatches", () => {
  test("filters by tag", () => {
    const state = makeState();
    const matches = findBlockSdtMatches(state.doc, { tag: "name" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.node.attrs["alias"]).toBe("Name");
  });

  test("findBlockSdtMatch returns null when nothing matches", () => {
    const state = makeState();
    expect(findBlockSdtMatch(state.doc, { tag: "missing" })).toBeNull();
  });

  test("filter by pmPos addresses one specific instance, not the first matching tag", () => {
    // Two SDTs share the tag "name"; setContentControlValueTr must land on
    // the one the user actually clicked (identified by pmPos), not the
    // first one in document order.
    const first = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "name" },
      [schema.node("paragraph", {}, [schema.text("first")])],
    );
    const second = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "name" },
      [schema.node("paragraph", {}, [schema.text("second")])],
    );
    const state = makeState(schema.node("doc", null, [first, second]));
    const allByTag = findBlockSdtMatches(state.doc, { tag: "name" });
    expect(allByTag).toHaveLength(2);

    const secondPos = allByTag[1]?.pos;
    if (typeof secondPos !== "number") {
      throw new TypeError("expected pos to be a number");
    }
    const onlySecond = findBlockSdtMatches(state.doc, { pmPos: secondPos });
    expect(onlySecond).toHaveLength(1);
    expect(onlySecond[0]?.node.firstChild?.textContent).toBe("second");
  });
});

describe("blockSdtAttrsToSdtProperties", () => {
  test("surfaces every modeled field (lock, placeholder, dateFormat, listItems, checked)", () => {
    const node = schema.node(
      "blockSdt",
      {
        sdtType: "dropdown",
        alias: "State",
        tag: "state",
        id: 42,
        lock: "contentLocked",
        placeholder: "Pick a state",
        showingPlaceholder: true,
        dateFormat: null,
        listItems: JSON.stringify([
          { value: "ca", displayText: "California" },
          { value: "ny", displayText: "New York" },
        ]),
        checked: null,
      },
      [schema.node("paragraph", {}, [])],
    );
    const props = blockSdtAttrsToSdtProperties(node);
    expect(props.sdtType).toBe("dropdown");
    expect(props.alias).toBe("State");
    expect(props.tag).toBe("state");
    expect(props.id).toBe(42);
    expect(props.lock).toBe("contentLocked");
    expect(props.placeholder).toBe("Pick a state");
    expect(props.showingPlaceholder).toBe(true);
    expect(props.listItems).toEqual([
      { value: "ca", displayText: "California" },
      { value: "ny", displayText: "New York" },
    ]);
  });
});

describe("setContentControlContentTr", () => {
  test("replaces the SDT children with a paragraph carrying the new text", () => {
    const state = makeState();
    const tr = setContentControlContentTr(state, { tag: "name" }, "replaced");
    if (!tr) {
      throw new Error("expected a transaction");
    }
    const next = state.apply(tr);
    const sdt = next.doc.firstChild;
    expect(sdt?.type.name).toBe("blockSdt");
    expect(sdt?.firstChild?.textContent).toBe("replaced");
  });

  test("returns null when no control matches", () => {
    const state = makeState();
    expect(
      setContentControlContentTr(state, { tag: "missing" }, "x"),
    ).toBeNull();
  });

  test("refuses to write into a locked control without force", () => {
    const lockedSdt = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "locked", lock: "contentLocked" },
      [schema.node("paragraph", {}, [schema.text("x")])],
    );
    const state = makeState(schema.node("doc", null, [lockedSdt]));
    expect(() =>
      setContentControlContentTr(state, { tag: "locked" }, "boom"),
    ).toThrow(ContentControlLockedError);
  });
});

describe("setContentControlValueTr", () => {
  test("toggles a checkbox and writes the checked attribute", () => {
    const checkbox = schema.node(
      "blockSdt",
      { sdtType: "checkbox", tag: "agree", checked: false },
      [schema.node("paragraph", {}, [schema.text("☐")])],
    );
    const state = makeState(schema.node("doc", null, [checkbox]));
    const tr = setContentControlValueTr(
      state,
      { tag: "agree" },
      {
        kind: "checkbox",
        checked: true,
      },
    );
    if (!tr) {
      throw new Error("expected tx");
    }
    const next = state.apply(tr);
    const sdt = next.doc.firstChild;
    expect(sdt?.attrs["checked"]).toBe(true);
    expect(sdt?.firstChild?.textContent).toBe("☒");
  });

  test("rejects a checkbox toggle on a richText control", () => {
    const state = makeState();
    expect(() =>
      setContentControlValueTr(
        state,
        { tag: "name" },
        {
          kind: "checkbox",
          checked: true,
        },
      ),
    ).toThrow(ContentControlTypeError);
  });
});

describe("removeContentControlTr", () => {
  test("drops the control by default", () => {
    const state = makeState();
    const tr = removeContentControlTr(state, { tag: "name" });
    if (!tr) {
      throw new Error("expected tx");
    }
    const next = state.apply(tr);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild?.type.name).toBe("paragraph");
  });

  test("keepContent: true unwraps the children in place", () => {
    const state = makeState();
    const tr = removeContentControlTr(
      state,
      { tag: "name" },
      {
        keepContent: true,
      },
    );
    if (!tr) {
      throw new Error("expected tx");
    }
    const next = state.apply(tr);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.firstChild?.type.name).toBe("paragraph");
    expect(next.doc.firstChild?.textContent).toBe("original");
  });

  test("contentLocked allows container removal (OOXML lock semantics)", () => {
    const sdt = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "a", lock: "contentLocked" },
      [schema.node("paragraph", {}, [schema.text("x")])],
    );
    const state = makeState(schema.node("doc", null, [sdt]));
    const tr = removeContentControlTr(state, { tag: "a" });
    if (!tr) {
      throw new Error("expected tx");
    }
    const next = state.apply(tr);
    expect(next.doc.firstChild?.type.name).not.toBe("blockSdt");
  });

  test("sdtLocked refuses container removal but allows content edits", () => {
    const sdt = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "a", lock: "sdtLocked" },
      [schema.node("paragraph", {}, [schema.text("x")])],
    );
    const state = makeState(schema.node("doc", null, [sdt]));
    expect(() => removeContentControlTr(state, { tag: "a" })).toThrow(
      ContentControlLockedError,
    );
    // ... but content edits succeed.
    const tr = setContentControlContentTr(state, { tag: "a" }, "edit ok");
    expect(tr).not.toBeNull();
  });

  test("does not stamp insertion marks when suggesting mode is active", () => {
    // Toggling a checkbox / picking a date through a widget should not be
    // re-classified as a tracked insertion by the suggestion-mode
    // appendTransaction catch-all — the mutation is a typed write
    // against the SDT's state, not a user-authored edit. We assert that
    // by activating suggestion mode and confirming the new body text
    // carries no insertion mark.
    const checkbox = schema.node(
      "blockSdt",
      { sdtType: "checkbox", tag: "agree", checked: false },
      [schema.node("paragraph", {}, [schema.text("☐")])],
    );
    const state = EditorState.create({
      doc: schema.node("doc", null, [checkbox]),
      schema,
      plugins: [
        createSuggestionModePlugin(true, "Reviewer"),
        ...singletonManager.getPlugins(),
      ],
    });
    const tr = setContentControlValueTr(
      state,
      { tag: "agree" },
      {
        kind: "checkbox",
        checked: true,
      },
    );
    if (!tr) {
      throw new TypeError("expected tx");
    }
    const next = state.apply(tr);
    const sdt = next.doc.firstChild;
    const firstText = sdt?.firstChild?.firstChild;
    expect(sdt?.attrs["checked"]).toBe(true);
    // The new text node must not carry an `insertion` mark — that would
    // be visible to reviewers as a pending change they have to accept.
    const insertionType = schema.marks["insertion"];
    if (!insertionType) {
      throw new TypeError("expected insertion mark in schema");
    }
    const hasInsertion = firstText?.marks.some(
      (mark) => mark.type === insertionType,
    );
    expect(hasInsertion).toBe(false);
  });

  test("refuses to unwrap a w15:repeatingSection without force", () => {
    const repeating = schema.node(
      "blockSdt",
      {
        sdtType: "richText",
        tag: "parties",
        rawPropertiesXml:
          '<w:sdtPr><w:tag w:val="parties"/><w15:repeatingSection/></w:sdtPr>',
      },
      [schema.node("paragraph", {}, [])],
    );
    const state = makeState(schema.node("doc", null, [repeating]));
    expect(() =>
      removeContentControlTr(state, { tag: "parties" }, { keepContent: true }),
    ).toThrow(ContentControlTypeError);
  });
});
