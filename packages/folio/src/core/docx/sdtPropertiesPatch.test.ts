/**
 * Tests for the rawSdtPr reconcile helper. Asserts that modeled property
 * mutations get patched into the raw XML before the serializer replays it,
 * so checkbox / dropdown / date interactions survive a save cycle.
 */

import { describe, expect, test } from "bun:test";

import type { SdtProperties } from "../types/document";
import { reconcileRawSdtPr } from "./sdtPropertiesPatch";

function checkboxProps(checked: boolean): SdtProperties {
  return {
    sdtType: "checkbox",
    checked,
  };
}

describe("reconcileRawSdtPr — checkbox state", () => {
  test("updates an existing w14:checked attribute when the user toggles on", () => {
    const raw =
      '<w:sdtPr><w:tag w:val="agree"/><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr>';
    const out = reconcileRawSdtPr(raw, checkboxProps(true));
    expect(out).toContain('<w14:checked w14:val="1"/>');
    expect(out).not.toContain('w14:val="0"');
    // Pre-existing markers (tag) survive.
    expect(out).toContain('<w:tag w:val="agree"/>');
  });

  test("updates an existing w:checked attribute (no w14: prefix variant)", () => {
    const raw =
      '<w:sdtPr><w:checkbox><w:checked w:val="0"/></w:checkbox></w:sdtPr>';
    const out = reconcileRawSdtPr(raw, checkboxProps(true));
    expect(out).toContain('<w:checked w:val="1"/>');
  });

  test("injects a w14:checked when only the wrapper exists", () => {
    const raw = "<w:sdtPr><w14:checkbox></w14:checkbox></w:sdtPr>";
    const out = reconcileRawSdtPr(raw, checkboxProps(true));
    expect(out).toContain('<w14:checked w14:val="1"/>');
  });

  test("synthesizes the whole wrapper when the raw sdtPr has neither", () => {
    const raw = '<w:sdtPr><w:tag w:val="agree"/></w:sdtPr>';
    const out = reconcileRawSdtPr(raw, checkboxProps(false));
    expect(out).toContain("<w14:checkbox>");
    expect(out).toContain('<w14:checked w14:val="0"/>');
    expect(out).toContain('<w:tag w:val="agree"/>');
  });
});

describe("reconcileRawSdtPr — dataBinding / repeatingSection passthrough", () => {
  test("preserves w15:repeatingSection while updating checked state", () => {
    const raw =
      '<w:sdtPr><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox><w15:repeatingSection/></w:sdtPr>';
    const out = reconcileRawSdtPr(raw, checkboxProps(true));
    expect(out).toContain("w15:repeatingSection");
    expect(out).toContain('<w14:checked w14:val="1"/>');
  });

  test("preserves w:dataBinding while updating w:date@w:fullDate", () => {
    const raw =
      '<w:sdtPr><w:dataBinding w:xpath="/c/d" w:storeItemID="{ABC}"/><w:date w:fullDate="2020-01-01T00:00:00Z"><w:dateFormat w:val="yyyy-MM-dd"/></w:date></w:sdtPr>';
    const out = reconcileRawSdtPr(
      raw,
      { sdtType: "date", dateFormat: "yyyy-MM-dd" },
      { dateFullDate: "2026-06-02T00:00:00Z" },
    );
    expect(out).toContain('w:fullDate="2026-06-02T00:00:00Z"');
    expect(out).toContain('w:xpath="/c/d"');
  });
});

describe("reconcileRawSdtPr — date format", () => {
  test("updates dateFormat without disturbing the surrounding w:date element", () => {
    const raw =
      '<w:sdtPr><w:date w:fullDate="2026-06-02"><w:dateFormat w:val="d MMMM yyyy"/><w:lid w:val="en-GB"/></w:date></w:sdtPr>';
    const out = reconcileRawSdtPr(
      raw,
      { sdtType: "date", dateFormat: "yyyy-MM-dd" },
      { dateFullDate: "2026-06-02" },
    );
    expect(out).toContain('<w:dateFormat w:val="yyyy-MM-dd"/>');
    expect(out).toContain('<w:lid w:val="en-GB"/>');
  });
});

describe("reconcileRawSdtPr — dropdown last value", () => {
  test("rewrites w:lastValue when the user picks a new item", () => {
    const raw =
      '<w:sdtPr><w:dropDownList w:lastValue="ca"><w:listItem w:displayText="California" w:value="ca"/><w:listItem w:displayText="New York" w:value="ny"/></w:dropDownList></w:sdtPr>';
    const out = reconcileRawSdtPr(
      raw,
      { sdtType: "dropdown" },
      { dropdownLastValue: "ny" },
    );
    expect(out).toContain('w:lastValue="ny"');
    expect(out).not.toContain('w:lastValue="ca"');
    // listItems are preserved.
    expect(out).toContain('w:value="ca"');
    expect(out).toContain('w:value="ny"');
  });

  test("escapes special characters in the new last value", () => {
    const raw = "<w:sdtPr><w:dropDownList/></w:sdtPr>";
    const out = reconcileRawSdtPr(
      raw,
      { sdtType: "dropdown" },
      { dropdownLastValue: 'Q&A "wrapped"' },
    );
    expect(out).toContain('w:lastValue="Q&amp;A &quot;wrapped&quot;"');
  });
});

describe("reconcileRawSdtPr — showingPlaceholder toggle", () => {
  test("removes <w:showingPlcHdr/> when the user fills the control", () => {
    const raw = '<w:sdtPr><w:tag w:val="x"/><w:showingPlcHdr/></w:sdtPr>';
    const out = reconcileRawSdtPr(raw, {
      sdtType: "richText",
      showingPlaceholder: false,
    });
    expect(out).not.toContain("showingPlcHdr");
    expect(out).toContain('<w:tag w:val="x"/>');
  });

  test("inserts <w:showingPlcHdr/> when the model says it is shown", () => {
    const raw = '<w:sdtPr><w:tag w:val="x"/></w:sdtPr>';
    const out = reconcileRawSdtPr(raw, {
      sdtType: "richText",
      showingPlaceholder: true,
    });
    expect(out).toContain("<w:showingPlcHdr/>");
  });
});
