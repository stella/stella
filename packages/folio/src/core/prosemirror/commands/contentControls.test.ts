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

  test("path includes the index of every enclosing ancestor for a nested SDT", () => {
    // Outer SDT contains a paragraph, then an inner SDT. The inner
    // match's path should reflect the doc → outer → inner ancestry so
    // callers can walk back to it via doc.child(path[0]).child(path[1]).
    const inner = schema.node("blockSdt", { sdtType: "richText", tag: "in" }, [
      schema.node("paragraph", {}, [schema.text("deep")]),
    ]);
    const outer = schema.node("blockSdt", { sdtType: "richText", tag: "out" }, [
      schema.node("paragraph", {}, [schema.text("pre")]),
      inner,
    ]);
    const state = makeState(schema.node("doc", null, [outer]));
    const match = findBlockSdtMatch(state.doc, { tag: "in" });
    if (!match) {
      throw new TypeError("expected inner match");
    }
    // Outer is doc child 0; inner is outer's child 1.
    expect(match.path).toEqual([0, 1]);
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

  test("tolerates malformed listItems JSON and falls back to writing the raw value", () => {
    const sdt = schema.node(
      "blockSdt",
      {
        sdtType: "dropdown",
        tag: "state",
        listItems: "not even close to JSON {{",
      },
      [schema.node("paragraph", {}, [])],
    );
    const state = makeState(schema.node("doc", null, [sdt]));
    // Should not throw despite the malformed listItems attribute.
    const tr = setContentControlValueTr(
      state,
      { tag: "state" },
      {
        kind: "dropdown",
        value: "California",
      },
    );
    if (!tr) {
      throw new TypeError("expected tx");
    }
    const next = state.apply(tr);
    expect(next.doc.firstChild?.firstChild?.textContent).toBe("California");
  });

  test("date: accepts fractional seconds (Date.prototype.toISOString output)", () => {
    // `new Date("2026-06-02").toISOString()` emits 2026-06-02T00:00:00.000Z.
    // Without fractional-seconds support, the regex missed it and the
    // helper fell back to `new Date(iso)`, which would format the value
    // via UTC accessors and shift the rendered day in non-UTC zones.
    const sdt = schema.node(
      "blockSdt",
      { sdtType: "date", tag: "due", dateFormat: "yyyy-MM-dd" },
      [schema.node("paragraph", {}, [])],
    );
    const state = makeState(schema.node("doc", null, [sdt]));
    const tr = setContentControlValueTr(
      state,
      { tag: "due" },
      { kind: "date", date: "2026-06-02T00:00:00.000Z" },
    );
    if (!tr) {
      throw new TypeError("expected tx");
    }
    const next = state.apply(tr);
    // Local-time component parsing means the rendered body always shows
    // the same calendar date the source ISO names, regardless of TZ.
    expect(next.doc.firstChild?.firstChild?.textContent).toBe("2026-06-02");
  });

  test("date: rejects partial-prefix dateValueISO and writes the raw value", () => {
    // Without an end anchor, `2026-06-02abc` matched the regex prefix and
    // formatDate happily rendered the well-formed slice. The model would
    // still store the malformed ISO, so the visible body silently
    // disagreed with the bound value.
    const sdt = schema.node(
      "blockSdt",
      { sdtType: "date", tag: "due", dateFormat: "yyyy-MM-dd" },
      [schema.node("paragraph", {}, [])],
    );
    const state = makeState(schema.node("doc", null, [sdt]));
    const tr = setContentControlValueTr(
      state,
      { tag: "due" },
      { kind: "date", date: "2026-06-02abc" },
    );
    if (!tr) {
      throw new TypeError("expected tx");
    }
    const next = state.apply(tr);
    // Falls back to "return unchanged" rendering — the body shows the
    // raw input rather than a deceptively well-formatted partial match.
    expect(next.doc.firstChild?.firstChild?.textContent).toBe("2026-06-02abc");
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

  test("removing the only top-level SDT inserts an empty paragraph (doc stays valid)", () => {
    // Doc consists of a single blockSdt; deleting it would leave the doc
    // with 0 children, violating the `(...)+` doc content spec. The PM
    // helper must substitute a placeholder paragraph, matching the
    // headless removeContentControl behavior.
    const sdt = schema.node("blockSdt", { sdtType: "richText", tag: "lone" }, [
      schema.node("paragraph", {}, [schema.text("solo")]),
    ]);
    const state = makeState(schema.node("doc", null, [sdt]));
    const tr = removeContentControlTr(state, { tag: "lone" });
    if (!tr) {
      throw new TypeError("expected tx");
    }
    const next = state.apply(tr);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild?.type.name).toBe("paragraph");
    expect(next.doc.firstChild?.content.size).toBe(0);
  });

  test("removes a nested-only-child blockSdt without breaking parent's block+ schema", () => {
    // The parent blockSdt has `content: "block+"`, so removing its sole
    // inner blockSdt without substituting a block would leave the parent
    // empty and fail schema validation. The PM helper must substitute a
    // placeholder paragraph here too, matching the doc-root case.
    const inner = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "inner" },
      [schema.node("paragraph", {}, [schema.text("solo")])],
    );
    const outer = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "outer" },
      [inner],
    );
    const state = makeState(schema.node("doc", null, [outer]));
    const tr = removeContentControlTr(state, { tag: "inner" });
    if (!tr) {
      throw new TypeError("expected tx");
    }
    const next = state.apply(tr);
    // Outer survives; its single child is now the placeholder paragraph.
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild?.type.name).toBe("blockSdt");
    expect(next.doc.firstChild?.childCount).toBe(1);
    expect(next.doc.firstChild?.firstChild?.type.name).toBe("paragraph");
    expect(next.doc.firstChild?.firstChild?.content.size).toBe(0);
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
