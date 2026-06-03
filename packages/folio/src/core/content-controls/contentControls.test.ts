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

  test("refuses pmPos-only filters on the headless model", () => {
    // pmPos is a PM-position concept; the headless `BlockSdt` model has
    // no positions. Letting the filter no-op would silently match every
    // control and a headless `setContentControlValue(doc, { pmPos }, …)`
    // would mutate them all. The matcher must refuse unsatisfiable
    // pmPos-only filters.
    const doc = makeDoc([
      makeControl({ tag: "a" }, "first"),
      makeControl({ tag: "b" }, "second"),
    ]);
    expect(findContentControls(doc, { pmPos: 0 })).toHaveLength(0);
    expect(findContentControls(doc, { pmPos: 42 })).toHaveLength(0);
    // Combined with a stable filter, pmPos still refuses on the headless
    // side (we'd need the PM walker to honor it).
    expect(findContentControls(doc, { pmPos: 0, tag: "a" })).toHaveLength(0);
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

  test("sets a date value (no dateFormat → body shows ISO input)", () => {
    const doc = makeDoc([makeControl({ tag: "effective", sdtType: "date" })]);
    const updated = setContentControlValue(
      doc,
      { tag: "effective" },
      { kind: "date", date: "2026-06-02" },
    );
    const ctrl = findContentControl(updated, { tag: "effective" })!.control;
    expect(getContentControlText(ctrl)).toBe("2026-06-02");
    expect(ctrl.properties.dateValueISO).toBe("2026-06-02");
  });

  test("date-only ISO is rendered as the same calendar day regardless of TZ", () => {
    // `new Date("2026-06-02")` parses as UTC midnight; a user in any
    // negative-offset TZ would see Date#getDate() return 1 instead of 2.
    // Pin the contract: a date-only input renders as the picked day.
    const doc = makeDoc([
      makeControl({
        tag: "effective",
        sdtType: "date",
        dateFormat: "yyyy-MM-dd",
      }),
    ]);
    const updated = setContentControlValue(
      doc,
      { tag: "effective" },
      { kind: "date", date: "2026-06-02" },
    );
    const ctrl = findContentControl(updated, { tag: "effective" })!.control;
    expect(getContentControlText(ctrl)).toBe("2026-06-02");
  });

  test("rejects overflowed date-only inputs instead of silently normalizing", () => {
    // `new Date(2026, 98, 99)` would silently become a real (distant)
    // date. The helper documents "return unchanged if the input does
    // not parse", so an overflow input should leave the body alone.
    const doc = makeDoc([
      makeControl({
        tag: "x",
        sdtType: "date",
        dateFormat: "yyyy-MM-dd",
      }),
    ]);
    const updated = setContentControlValue(
      doc,
      { tag: "x" },
      { kind: "date", date: "2026-99-99" },
    );
    const ctrl = findContentControl(updated, { tag: "x" })!.control;
    // Body shows the raw input, not a normalized real date.
    expect(getContentControlText(ctrl)).toBe("2026-99-99");
  });

  test("datetime input preserves the picked wall-clock time in the formatted display", () => {
    // A date SDT with a time-bearing format ("yyyy-MM-dd HH:mm") must
    // render the user's picked time, not zero it out. Previously the
    // regex only extracted YYYY-MM-DD and the body showed "15:30" as
    // "00:00".
    const doc = makeDoc([
      makeControl({
        tag: "scheduled",
        sdtType: "date",
        dateFormat: "yyyy-MM-dd HH:mm",
      }),
    ]);
    const updated = setContentControlValue(
      doc,
      { tag: "scheduled" },
      { kind: "date", date: "2026-06-02T15:30:00Z" },
    );
    const ctrl = findContentControl(updated, { tag: "scheduled" })!.control;
    expect(getContentControlText(ctrl)).toBe("2026-06-02 15:30");
    expect(ctrl.properties.dateValueISO).toBe("2026-06-02T15:30:00Z");
  });

  test("with a dateFormat, body shows the rendered display + dateValueISO holds ISO", () => {
    const doc = makeDoc([
      makeControl({
        tag: "effective",
        sdtType: "date",
        dateFormat: "d MMMM yyyy",
      }),
    ]);
    const updated = setContentControlValue(
      doc,
      { tag: "effective" },
      { kind: "date", date: "2026-06-02" },
    );
    const ctrl = findContentControl(updated, { tag: "effective" })!.control;
    expect(getContentControlText(ctrl)).toBe("2 June 2026");
    // Critical: w:fullDate round-trip uses the ISO value, NOT the display.
    expect(ctrl.properties.dateValueISO).toBe("2026-06-02");
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

  test("removing an only-child nested SDT keeps the outer SDT non-empty", () => {
    // Outer SDT contains exactly one inner SDT; removing the inner one
    // would leave the outer with empty content. The model invariant is
    // that wrappers carry at least one child block — verify we patch a
    // placeholder paragraph into the outer.
    const inner = makeControl({ tag: "inner" }, "doomed");
    const outer: BlockSdt = {
      type: "blockSdt",
      properties: { sdtType: "richText", tag: "outer" },
      content: [inner],
    };
    const doc = makeDoc([outer]);
    const updated = removeContentControl(doc, { tag: "inner" });
    const outerAfter = updated.package.document.content[0];
    if (!outerAfter || outerAfter.type !== "blockSdt") {
      throw new TypeError("expected outer to remain a blockSdt");
    }
    expect(outerAfter.content).toHaveLength(1);
    expect(outerAfter.content[0]?.type).toBe("paragraph");
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

  test("refuses to unwrap a repeatingSection under an alternate namespace prefix", () => {
    // A producer that binds the Word 2012 namespace under a non-canonical
    // prefix (`<ns0:repeatingSection/>`) was previously slipping through
    // the literal substring check and getting unwrapped — which would
    // orphan the section's row items in the resulting DOCX.
    const repeating: BlockSdt = {
      type: "blockSdt",
      properties: {
        sdtType: "richText",
        tag: "rows",
        rawPropertiesXml:
          '<w:sdtPr><w:tag w:val="rows"/><ns0:repeatingSection/></w:sdtPr>',
      },
      content: [makePara("x")],
    };
    const doc = makeDoc([repeating]);
    expect(() =>
      removeContentControl(doc, { tag: "rows" }, { keepContent: true }),
    ).toThrow(ContentControlTypeError);
  });
});
