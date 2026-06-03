/**
 * Property-based round-trip tests for `<w:sdtPr>` (block-level content control
 * properties).
 *
 * Three invariants are asserted on randomly generated, valid sdtPr XML:
 *
 *   1. Prefix invariance — the same logical sdtPr written under an
 *      alternate prefix that binds to the WordprocessingML URI parses to
 *      the same modeled projection as the canonical `w:` form. The raw
 *      replay buffer is excluded (its bytes legitimately differ; the
 *      projection must not).
 *   2. OnOff invariance — every spec-permitted OnOff form (absent attribute,
 *      `1`/`0`, `true`/`false`, `on`/`off`) for `<w:showingPlcHdr>` and
 *      `<w14:checked@val>` produces the right boolean (presence-implies-true,
 *      and the negation forms read as false).
 *   3. Round-trip equivalence — parse → reconcileRawSdtPr(props) → re-parse
 *      yields the same projection (excluding raw* buffers, which the
 *      reconcile step intentionally rewrites in place).
 *
 * Out of scope (separate follow-ups): corpus tests against sample DOCX
 * files, differential testing vs. another OOXML parser, XSD validation
 * against ECMA-376.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { SdtProperties } from "../types/document";
import { parseSdtProperties } from "./sdtProperties";
import { reconcileRawSdtPr } from "./sdtPropertiesPatch";
import { parseXml } from "./xmlParser";

// ============================================================================
// Helpers
// ============================================================================

const W_URI = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_URI = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_URI = "http://schemas.microsoft.com/office/word/2012/wordml";

/**
 * Wrap an sdtPr body in a root carrying the namespace declarations the
 * children need. The parser only sees the first element so we never have
 * to add bogus siblings.
 */
function buildSdtPrXml(body: string, prefixes: PrefixMap): string {
  const xmlns = [
    `xmlns:${prefixes.w}="${W_URI}"`,
    `xmlns:${prefixes.w14}="${W14_URI}"`,
    `xmlns:${prefixes.w15}="${W15_URI}"`,
  ].join(" ");
  return `<${prefixes.w}:sdtPr ${xmlns}>${body}</${prefixes.w}:sdtPr>`;
}

function buildSdtEndPrXml(body: string, prefixes: PrefixMap): string {
  const xmlns = `xmlns:${prefixes.w}="${W_URI}"`;
  return `<${prefixes.w}:sdtEndPr ${xmlns}>${body}</${prefixes.w}:sdtEndPr>`;
}

function parseSdtPr(xml: string): SdtProperties {
  const root = parseXml(xml);
  const sdtPr = root.elements?.[0];
  if (!sdtPr) {
    throw new TypeError("expected sdtPr root element");
  }
  return parseSdtProperties(sdtPr);
}

function parseSdtPrPair(
  sdtPrXml: string,
  sdtEndPrXml: string | null,
): SdtProperties {
  const sdtPrRoot = parseXml(sdtPrXml);
  const sdtPrEl = sdtPrRoot.elements?.[0];
  if (!sdtPrEl) {
    throw new TypeError("expected sdtPr root element");
  }
  let sdtEndPrEl = null;
  if (sdtEndPrXml) {
    const endRoot = parseXml(sdtEndPrXml);
    sdtEndPrEl = endRoot.elements?.[0] ?? null;
  }
  return parseSdtProperties(sdtPrEl, sdtEndPrEl);
}

/**
 * Strip fields the comparison must ignore. `rawPropertiesXml` and
 * `rawEndPropertiesXml` are byte buffers (legitimately differ between
 * prefix variants and after a reconcile pass); the modeled projection is
 * what we compare.
 */
function projection(
  props: SdtProperties,
): Omit<SdtProperties, "rawPropertiesXml" | "rawEndPropertiesXml"> {
  const { rawPropertiesXml, rawEndPropertiesXml, ...rest } = props;
  void rawPropertiesXml;
  void rawEndPropertiesXml;
  return rest;
}

// ============================================================================
// Prefix arbitrary
// ============================================================================

type PrefixMap = { w: string; w14: string; w15: string };

/**
 * Generate three distinct prefixes for the three SDT namespaces. We keep
 * the canonical case as one possibility and otherwise produce short
 * alphabetic prefixes guaranteed not to collide.
 */
const arbAltPrefixMap: fc.Arbitrary<PrefixMap> = fc
  .tuple(
    fc.constantFrom("w", "ns0", "wp", "a", "x"),
    fc.constantFrom("w14", "ns14", "wfourteen", "b"),
    fc.constantFrom("w15", "ns15", "wfifteen", "c"),
  )
  .filter(([w, w14, w15]) => w !== w14 && w !== w15 && w14 !== w15)
  .map(([w, w14, w15]) => ({ w, w14, w15 }));

const canonicalPrefixes: PrefixMap = { w: "w", w14: "w14", w15: "w15" };

// ============================================================================
// Element-body arbitraries (emit `<prefix:tag …/>` strings)
// ============================================================================

/**
 * Safe attribute string: ASCII letters/digits/space, no XML metacharacters,
 * no leading/trailing whitespace (Word collapses those on save, which
 * would break parse → reconcile → re-parse equality).
 */
const arbSafeAttrValue = fc
  .string({
    minLength: 1,
    maxLength: 32,
    unit: fc.constantFrom(
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      " ",
      "-",
      "_",
    ),
  })
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.includes("  "));

const arbId = fc.integer({ min: 0, max: 2_147_483_647 });

const arbLockValue: fc.Arbitrary<NonNullable<SdtProperties["lock"]>> =
  fc.constantFrom("sdtLocked", "contentLocked", "sdtContentLocked", "unlocked");

/** Spec-permitted OnOff val attribute forms, including absent. */
const arbOnOffForm = fc.constantFrom(
  { val: undefined, expected: true },
  { val: "1", expected: true },
  { val: "true", expected: true },
  { val: "on", expected: true },
  { val: "0", expected: false },
  { val: "false", expected: false },
  { val: "off", expected: false },
);

function renderOnOffAttr(form: { val: string | undefined }, prefix: string) {
  return form.val === undefined ? "" : ` ${prefix}:val="${form.val}"`;
}

/**
 * Generate an arbitrary `<w:date>` body. Covers fullDate with fractional
 * seconds and TZ suffix (Z and ±HH:MM).
 */
const arbDateFullDate = fc.oneof(
  fc.constant("2026-06-02T00:00:00Z"),
  fc.constant("2026-06-02T12:30:45.123Z"),
  fc.constant("2026-06-02T12:30:45.000456Z"),
  fc.constant("2026-06-02T12:30:45+02:00"),
  fc.constant("2026-06-02T12:30:45.5-05:00"),
  fc.constant("2026-06-02"),
);

const arbDateFormat = fc.constantFrom(
  "yyyy-MM-dd",
  "d MMMM yyyy",
  "M/d/yyyy",
  "dd.MM.yyyy",
);

/**
 * Generate a list of {displayText, value} items with at least one duplicate-
 * displayText case (covered explicitly via fc.constant pairs), plus empty
 * strings. Capped at 4 items to keep the search space manageable.
 */
const arbListItem = fc.tuple(
  fc.oneof(fc.constant(""), fc.constant("dup"), arbSafeAttrValue),
  fc.oneof(fc.constant(""), arbSafeAttrValue),
);

const arbListItems = fc.array(arbListItem, { minLength: 0, maxLength: 4 });

// SDT type arbitrary — every variant the spec lets a block-level SDT carry.
const arbSdtTypeKind = fc.constantFrom(
  "richText",
  "plainText",
  "dropdown",
  "comboBox",
  "date",
  "checkbox",
  "picture",
  "docPartObj",
  "group",
);

/** Wraps any sdtPr body around a given list of optional fragments. */
function joinFragments(fragments: (string | null | undefined)[]): string {
  // `filter(Boolean)` narrows away null/undefined for the joiner; ts knows
  // the resulting array's element type stays `string | …` so the join is safe.
  return fragments.filter(Boolean).join("");
}

/**
 * Build the per-type marker fragment for a given SDT type, using the
 * passed prefix map. Returns the marker XML and (for OnOff-carrying
 * types) the expected modeled state.
 */
type TypeFragmentSpec = {
  body: string;
  expected: Partial<SdtProperties>;
};

function buildTypeFragment(
  kind:
    | "richText"
    | "plainText"
    | "dropdown"
    | "comboBox"
    | "date"
    | "checkbox"
    | "picture"
    | "docPartObj"
    | "group",
  prefixes: PrefixMap,
  rng: {
    onOff: { val: string | undefined; expected: boolean };
    fullDate: string;
    dateFormat: string | undefined;
    listItems: [string, string][];
    dropdownLastValue: string | undefined;
  },
): TypeFragmentSpec {
  const w = prefixes.w;
  const w14 = prefixes.w14;
  if (kind === "richText") {
    return { body: "", expected: { sdtType: "richText" } };
  }
  if (kind === "plainText") {
    return {
      body: `<${w}:text/>`,
      expected: { sdtType: "plainText" },
    };
  }
  if (kind === "picture") {
    return {
      body: `<${w}:picture/>`,
      expected: { sdtType: "picture" },
    };
  }
  if (kind === "group") {
    return {
      body: `<${w}:group/>`,
      expected: { sdtType: "group" },
    };
  }
  if (kind === "docPartObj") {
    return {
      body: `<${w}:docPartObj><${w}:docPartGallery ${w}:val="Quick Parts"/></${w}:docPartObj>`,
      expected: { sdtType: "buildingBlockGallery" },
    };
  }
  if (kind === "checkbox") {
    const valAttr = renderOnOffAttr(rng.onOff, w14);
    return {
      body: `<${w14}:checkbox><${w14}:checked${valAttr}/></${w14}:checkbox>`,
      expected: { sdtType: "checkbox", checked: rng.onOff.expected },
    };
  }
  if (kind === "date") {
    const fmt = rng.dateFormat;
    const inner = fmt ? `<${w}:dateFormat ${w}:val="${fmt}"/>` : "";
    return {
      body: `<${w}:date ${w}:fullDate="${rng.fullDate}">${inner}</${w}:date>`,
      expected: {
        sdtType: "date",
        dateValueISO: rng.fullDate,
        ...(fmt ? { dateFormat: fmt } : {}),
      },
    };
  }
  // dropdown / comboBox.
  const tag = kind === "dropdown" ? "dropDownList" : "comboBox";
  const lastValueAttr =
    rng.dropdownLastValue !== undefined
      ? ` ${w}:lastValue="${rng.dropdownLastValue}"`
      : "";
  const items = rng.listItems
    .map(
      ([dt, val]) =>
        `<${w}:listItem ${w}:displayText="${dt}" ${w}:value="${val}"/>`,
    )
    .join("");
  // Both displayText and value carried verbatim; parser falls back if one
  // is absent, but we always emit both for round-trip stability.
  const expectedItems = rng.listItems.map(([dt, val]) => ({
    displayText: dt,
    value: val,
  }));
  return {
    body: `<${w}:${tag}${lastValueAttr}>${items}</${w}:${tag}>`,
    expected: {
      sdtType: kind === "dropdown" ? "dropdown" : "comboBox",
      listItems: expectedItems,
      ...(rng.dropdownLastValue !== undefined
        ? { dropdownLastValue: rng.dropdownLastValue }
        : {}),
    },
  };
}

// ============================================================================
// Top-level sdtPr arbitrary
// ============================================================================

type SdtSpec = {
  prefixes: PrefixMap;
  sdtPrXml: string;
  sdtEndPrXml: string | null;
  /**
   * Expected modeled projection (excluding raw* buffers and any fields the
   * generator chose to omit). All present-or-absent fields match the
   * generator's exact emission.
   */
  expected: Partial<SdtProperties>;
};

const arbSdtSpec: fc.Arbitrary<SdtSpec> = fc
  .record({
    prefixes: fc.constantFrom(canonicalPrefixes), // overridden in prefix-variance test
    kind: arbSdtTypeKind,
    id: fc.option(arbId, { nil: undefined }),
    alias: fc.option(arbSafeAttrValue, { nil: undefined }),
    tag: fc.option(arbSafeAttrValue, { nil: undefined }),
    lock: fc.option(arbLockValue, { nil: undefined }),
    placeholder: fc.option(arbSafeAttrValue, { nil: undefined }),
    onOff: arbOnOffForm,
    fullDate: arbDateFullDate,
    dateFormat: fc.option(arbDateFormat, { nil: undefined }),
    listItems: arbListItems,
    dropdownLastValue: fc.option(arbSafeAttrValue, { nil: undefined }),
    includeSdtEndPr: fc.boolean(),
  })
  .map((spec) => buildSpec(spec, spec.prefixes));

function buildSpec(
  spec: {
    kind:
      | "richText"
      | "plainText"
      | "dropdown"
      | "comboBox"
      | "date"
      | "checkbox"
      | "picture"
      | "docPartObj"
      | "group";
    id: number | undefined;
    alias: string | undefined;
    tag: string | undefined;
    lock: NonNullable<SdtProperties["lock"]> | undefined;
    placeholder: string | undefined;
    onOff: { val: string | undefined; expected: boolean };
    fullDate: string;
    dateFormat: string | undefined;
    listItems: [string, string][];
    dropdownLastValue: string | undefined;
    includeSdtEndPr: boolean;
  },
  prefixes: PrefixMap,
): SdtSpec {
  const w = prefixes.w;
  const idFrag =
    spec.id !== undefined ? `<${w}:id ${w}:val="${spec.id}"/>` : null;
  const aliasFrag =
    spec.alias !== undefined ? `<${w}:alias ${w}:val="${spec.alias}"/>` : null;
  const tagFrag =
    spec.tag !== undefined ? `<${w}:tag ${w}:val="${spec.tag}"/>` : null;
  const lockFrag =
    spec.lock !== undefined ? `<${w}:lock ${w}:val="${spec.lock}"/>` : null;
  const placeholderFrag =
    spec.placeholder !== undefined
      ? `<${w}:placeholder><${w}:docPart ${w}:val="${spec.placeholder}"/></${w}:placeholder>`
      : null;

  const typeSpec = buildTypeFragment(spec.kind, prefixes, {
    onOff: spec.onOff,
    fullDate: spec.fullDate,
    dateFormat: spec.dateFormat,
    listItems: spec.listItems,
    dropdownLastValue: spec.dropdownLastValue,
  });

  const body = joinFragments([
    idFrag,
    aliasFrag,
    tagFrag,
    lockFrag,
    placeholderFrag,
    typeSpec.body,
  ]);

  const sdtPrXml = buildSdtPrXml(body, prefixes);
  const sdtEndPrXml = spec.includeSdtEndPr
    ? buildSdtEndPrXml("", prefixes)
    : null;

  const expected: Partial<SdtProperties> = {
    ...typeSpec.expected,
  };
  if (spec.id !== undefined) {
    expected.id = spec.id;
  }
  if (spec.alias !== undefined) {
    expected.alias = spec.alias;
  }
  if (spec.tag !== undefined) {
    expected.tag = spec.tag;
  }
  // lock has a default of "unlocked" when the element is present; absent
  // element means undefined.
  if (spec.lock !== undefined) {
    expected.lock = spec.lock;
  }
  if (spec.placeholder !== undefined) {
    expected.placeholder = spec.placeholder;
  }

  return { prefixes, sdtPrXml, sdtEndPrXml, expected };
}

// ============================================================================
// PROPERTY 1 — Prefix invariance
// ============================================================================

describe("sdtPr property tests", () => {
  test("prefix invariance: alt-prefix sdtPr parses to same projection as canonical", () => {
    fc.assert(
      fc.property(
        // Build the spec body once on canonical prefixes, then re-render the
        // same logical content under random alt prefixes.
        arbSdtSpec,
        arbAltPrefixMap,
        (canonical, altPrefixes) => {
          const altSpec = rebuildUnderPrefixes(canonical, altPrefixes);
          const canonProps = projection(parseSdtPr(canonical.sdtPrXml));
          const altProps = projection(parseSdtPr(altSpec.sdtPrXml));
          expect(altProps).toEqual(canonProps);
        },
      ),
      // 150 runs is enough coverage for the sdtPr shape we generate, keeps
      // wall-clock well under the 30s budget noted in the task.
      { numRuns: 150 },
    );
  });

  // --------------------------------------------------------------------------
  // PROPERTY 2 — OnOff invariance
  // --------------------------------------------------------------------------

  test("OnOff invariance: showingPlcHdr accepts every spec form", () => {
    fc.assert(
      fc.property(arbOnOffForm, (form) => {
        const valAttr = renderOnOffAttr(form, "w");
        const xml = buildSdtPrXml(
          `<w:showingPlcHdr${valAttr}/>`,
          canonicalPrefixes,
        );
        const props = parseSdtPr(xml);
        expect(props.showingPlaceholder).toBe(form.expected);
      }),
      { numRuns: 50 },
    );
  });

  test("OnOff invariance: w14:checked val accepts every spec form", () => {
    fc.assert(
      fc.property(arbOnOffForm, (form) => {
        const valAttr = renderOnOffAttr(form, "w14");
        const xml = buildSdtPrXml(
          `<w14:checkbox><w14:checked${valAttr}/></w14:checkbox>`,
          canonicalPrefixes,
        );
        const props = parseSdtPr(xml);
        expect(props.sdtType).toBe("checkbox");
        expect(props.checked).toBe(form.expected);
      }),
      { numRuns: 50 },
    );
  });

  // --------------------------------------------------------------------------
  // PROPERTY 3 — Round-trip equivalence
  // --------------------------------------------------------------------------

  test("round-trip: parse → reconcile → re-parse yields the same projection", () => {
    fc.assert(
      fc.property(arbSdtSpec, (spec) => {
        const props1 = parseSdtPrPair(spec.sdtPrXml, spec.sdtEndPrXml);
        const raw = props1.rawPropertiesXml;
        if (!raw) {
          // Parser always sets it when sdtPr is present, but be explicit.
          throw new Error("expected rawPropertiesXml to be set after parse");
        }
        // Feed the modeled state back through the reconcile patcher with
        // the same dropdown / date payloads the parse round saw, so the
        // reconciled raw XML still represents the same logical control.
        const dateFullDate =
          props1.sdtType === "date" ? props1.dateValueISO : undefined;
        const dropdownLastValue =
          props1.sdtType === "dropdown" || props1.sdtType === "comboBox"
            ? props1.dropdownLastValue
            : undefined;
        const reconciled = reconcileRawSdtPr(raw, props1, {
          dateFullDate,
          dropdownLastValue,
        });
        // Re-parse the reconciled buffer. The original capture preserves
        // xmlns declarations on the sdtPr wrapper, so reconcile (which only
        // rewrites children + attributes) hands us a well-bound document.
        const reparsed = parseSdtPr(reconciled);
        expect(projection(reparsed)).toEqual(projection(props1));
      }),
      { numRuns: 150 },
    );
  });
});

// ============================================================================
// Helpers used by the property bodies
// ============================================================================

/**
 * Rebuild an SdtSpec under a different prefix map while keeping the same
 * generator inputs. We do this by re-deriving the body from `expected`
 * plus the original generator inputs — but the simpler path is to
 * regenerate from the spec field-by-field, which we don't have access to
 * here. Instead, we string-rewrite the canonical XML's prefixes to the
 * target ones (safe because we own the input format).
 */
function rebuildUnderPrefixes(spec: SdtSpec, prefixes: PrefixMap): SdtSpec {
  if (prefixes.w === "w" && prefixes.w14 === "w14" && prefixes.w15 === "w15") {
    return spec;
  }
  // Rewrite in order long-prefix-first so `w14` doesn't get partially
  // chewed by a `w` rewrite. Replace `<w14:` etc. tag opens, closes, and
  // attribute prefixes.
  const remap: { from: string; to: string }[] = [
    { from: "w14", to: prefixes.w14 },
    { from: "w15", to: prefixes.w15 },
    { from: "w", to: prefixes.w },
  ];
  let next = spec.sdtPrXml;
  let nextEnd = spec.sdtEndPrXml;
  for (const { from, to } of remap) {
    if (from === to) {
      continue;
    }
    const reOpen = new RegExp(`<${from}:`, "gu");
    const reClose = new RegExp(`</${from}:`, "gu");
    const reAttr = new RegExp(`\\s${from}:`, "gu");
    const reXmlns = new RegExp(`xmlns:${from}=`, "gu");
    next = next
      .replaceAll(reOpen, `<${to}:`)
      .replaceAll(reClose, `</${to}:`)
      .replaceAll(reAttr, ` ${to}:`)
      .replaceAll(reXmlns, `xmlns:${to}=`);
    if (nextEnd) {
      nextEnd = nextEnd
        .replaceAll(reOpen, `<${to}:`)
        .replaceAll(reClose, `</${to}:`)
        .replaceAll(reAttr, ` ${to}:`)
        .replaceAll(reXmlns, `xmlns:${to}=`);
    }
  }
  return {
    prefixes,
    sdtPrXml: next,
    sdtEndPrXml: nextEnd,
    expected: spec.expected,
  };
}
