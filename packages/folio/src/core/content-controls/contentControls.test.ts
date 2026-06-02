/**
 * Headless content-controls API tests.
 */

import { describe, expect, test } from "bun:test";

import {
  ContentControlLockedError,
  ContentControlTypeError,
  findContentControl,
  findContentControls,
  getContentControlText,
  removeContentControl,
  setContentControlContent,
  setContentControlValue,
} from ".";
import type { BlockSdt, Document, Paragraph } from "../types/document";

function makeDoc(content: BlockSdt[]): Document {
  return {
    package: {
      document: { content },
    },
  };
}

function makePara(text: string): Paragraph {
  return {
    type: "paragraph",
    content: [{ type: "run", content: [{ type: "text", text }] }],
  };
}

function makeControl(
  props: Partial<BlockSdt["properties"]>,
  text = "",
): BlockSdt {
  return {
    type: "blockSdt",
    properties: { sdtType: "richText", ...props } as BlockSdt["properties"],
    content: [makePara(text)],
  };
}

describe("findContentControls", () => {
  test("filters by tag, alias, id, sdtType", () => {
    const doc = makeDoc([
      makeControl({ tag: "a", alias: "A", id: 1 }, "first"),
      makeControl({ tag: "b", sdtType: "date" }, "second"),
    ]);
    expect(findContentControls(doc, { tag: "a" })).toHaveLength(1);
    expect(findContentControls(doc, { alias: "A" })).toHaveLength(1);
    expect(findContentControls(doc, { id: 1 })).toHaveLength(1);
    expect(findContentControls(doc, { sdtType: "date" })).toHaveLength(1);
    expect(findContentControls(doc, { tag: "a", id: 999 })).toHaveLength(0);
    expect(findContentControls(doc)).toHaveLength(2);
  });

  test("finds nested SDTs and reports their ancestry", () => {
    const inner = makeControl({ tag: "inner" }, "deep");
    const outer: BlockSdt = {
      type: "blockSdt",
      properties: { sdtType: "richText", tag: "outer" },
      content: [inner],
    };
    const doc = makeDoc([outer]);
    const matches = findContentControls(doc, { tag: "inner" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.ancestry).toHaveLength(1);
    expect(matches[0]?.ancestry[0]?.properties.tag).toBe("outer");
  });

  test("findContentControl returns the first match or null", () => {
    const doc = makeDoc([makeControl({ tag: "a" }, "x")]);
    expect(findContentControl(doc, { tag: "a" })?.control.properties.tag).toBe(
      "a",
    );
    expect(findContentControl(doc, { tag: "missing" })).toBeNull();
  });

  test("getContentControlText concatenates paragraph descendants", () => {
    const control: BlockSdt = {
      type: "blockSdt",
      properties: { sdtType: "richText" },
      content: [makePara("line one"), makePara("line two")],
    };
    expect(getContentControlText(control)).toBe("line one\nline two");
  });
});

describe("setContentControlContent", () => {
  test("replaces content with a single paragraph (string input)", () => {
    const doc = makeDoc([makeControl({ tag: "name" }, "old")]);
    const updated = setContentControlContent(doc, { tag: "name" }, "new");
    const ctrl = findContentControl(updated, { tag: "name" })!.control;
    expect(getContentControlText(ctrl)).toBe("new");
    expect(ctrl.properties.showingPlaceholder).toBe(false);
  });

  test("does not mutate the original document", () => {
    const doc = makeDoc([makeControl({ tag: "name" }, "old")]);
    setContentControlContent(doc, { tag: "name" }, "new");
    const original = findContentControl(doc, { tag: "name" })!.control;
    expect(getContentControlText(original)).toBe("old");
  });

  test("refuses to write into a contentLocked control without force", () => {
    const doc = makeDoc([
      makeControl({ tag: "locked", lock: "contentLocked" }, "x"),
    ]);
    expect(() =>
      setContentControlContent(doc, { tag: "locked" }, "boom"),
    ).toThrow(ContentControlLockedError);
  });

  test("force: true overrides the lock", () => {
    const doc = makeDoc([
      makeControl({ tag: "locked", lock: "contentLocked" }, "x"),
    ]);
    const updated = setContentControlContent(doc, { tag: "locked" }, "ok", {
      force: true,
    });
    const ctrl = findContentControl(updated, { tag: "locked" })!.control;
    expect(getContentControlText(ctrl)).toBe("ok");
  });
});

describe("setContentControlValue", () => {
  test("toggles a checkbox", () => {
    const doc = makeDoc([
      makeControl({ tag: "agree", sdtType: "checkbox", checked: false }),
    ]);
    const updated = setContentControlValue(
      doc,
      { tag: "agree" },
      { kind: "checkbox", checked: true },
    );
    const ctrl = findContentControl(updated, { tag: "agree" })!.control;
    expect(ctrl.properties.checked).toBe(true);
    expect(getContentControlText(ctrl)).toBe("☒");
  });

  test("rejects a checkbox toggle on a non-checkbox control", () => {
    const doc = makeDoc([makeControl({ tag: "name", sdtType: "richText" })]);
    expect(() =>
      setContentControlValue(
        doc,
        { tag: "name" },
        {
          kind: "checkbox",
          checked: true,
        },
      ),
    ).toThrow(ContentControlTypeError);
  });

  test("sets a dropdown value (display text from list items)", () => {
    const doc = makeDoc([
      makeControl({
        tag: "state",
        sdtType: "dropdown",
        listItems: [
          { value: "ca", displayText: "California" },
          { value: "ny", displayText: "New York" },
        ],
      }),
    ]);
    const updated = setContentControlValue(
      doc,
      { tag: "state" },
      { kind: "dropdown", value: "ny" },
    );
    const ctrl = findContentControl(updated, { tag: "state" })!.control;
    expect(getContentControlText(ctrl)).toBe("New York");
  });

  test("dropdown value not in listItems is refused without force", () => {
    const doc = makeDoc([
      makeControl({
        tag: "state",
        sdtType: "dropdown",
        listItems: [{ value: "ca", displayText: "California" }],
      }),
    ]);
    expect(() =>
      setContentControlValue(
        doc,
        { tag: "state" },
        {
          kind: "dropdown",
          value: "tx",
        },
      ),
    ).toThrow(ContentControlTypeError);
  });

  test("sets a date value", () => {
    const doc = makeDoc([makeControl({ tag: "effective", sdtType: "date" })]);
    const updated = setContentControlValue(
      doc,
      { tag: "effective" },
      { kind: "date", date: "2026-06-02" },
    );
    const ctrl = findContentControl(updated, { tag: "effective" })!.control;
    expect(getContentControlText(ctrl)).toBe("2026-06-02");
  });
});

describe("removeContentControl", () => {
  test("drops the control entirely by default", () => {
    const doc = makeDoc([
      makeControl({ tag: "a" }, "drop me"),
      makeControl({ tag: "b" }, "keep me"),
    ]);
    const updated = removeContentControl(doc, { tag: "a" });
    expect(updated.package.document.content).toHaveLength(1);
    expect(findContentControl(updated, { tag: "a" })).toBeNull();
  });

  test("keepContent: true unwraps the control, preserving children", () => {
    const doc = makeDoc([makeControl({ tag: "a" }, "preserved")]);
    const updated = removeContentControl(
      doc,
      { tag: "a" },
      {
        keepContent: true,
      },
    );
    expect(updated.package.document.content).toHaveLength(1);
    const para = updated.package.document.content[0];
    expect(para?.type).toBe("paragraph");
  });

  test("contentLocked does NOT block container removal (only blocks edits)", () => {
    // OOXML §17.5.2.16: contentLocked locks content, sdtLocked locks the
    // container. Removal must succeed on contentLocked.
    const doc = makeDoc([
      makeControl({ tag: "a", lock: "contentLocked" }, "x"),
    ]);
    const updated = removeContentControl(doc, { tag: "a" });
    expect(findContentControl(updated, { tag: "a" })).toBeNull();
  });

  test("sdtLocked refuses container removal even though edits are allowed", () => {
    const doc = makeDoc([makeControl({ tag: "a", lock: "sdtLocked" }, "x")]);
    expect(() => removeContentControl(doc, { tag: "a" })).toThrow(
      ContentControlLockedError,
    );
    // ... but a content edit IS allowed on sdtLocked.
    const updated = setContentControlContent(doc, { tag: "a" }, "edit ok");
    expect(
      getContentControlText(findContentControl(updated, { tag: "a" })!.control),
    ).toBe("edit ok");
  });

  test("sdtContentLocked blocks both edits and removal", () => {
    const doc = makeDoc([
      makeControl({ tag: "a", lock: "sdtContentLocked" }, "x"),
    ]);
    expect(() => removeContentControl(doc, { tag: "a" })).toThrow(
      ContentControlLockedError,
    );
    expect(() => setContentControlContent(doc, { tag: "a" }, "y")).toThrow(
      ContentControlLockedError,
    );
  });

  test("refuses to unwrap a w15:repeatingSection control without force", () => {
    const repeating: BlockSdt = {
      type: "blockSdt",
      properties: {
        sdtType: "richText",
        tag: "parties",
        rawPropertiesXml:
          '<w:sdtPr><w:tag w:val="parties"/><w15:repeatingSection/></w:sdtPr>',
      },
      content: [makePara("x")],
    };
    const doc = makeDoc([repeating]);
    expect(() =>
      removeContentControl(doc, { tag: "parties" }, { keepContent: true }),
    ).toThrow(ContentControlTypeError);
  });
});
