/**
 * Shared parser for Structured Document Tag properties (`w:sdtPr`).
 *
 * One parser feeds both the inline (run-level) SDT path and the block-level
 * SDT path so the two cannot drift. Emits a modeled projection AND captures
 * the raw `<w:sdtPr>` / `<w:sdtEndPr>` as verbatim XML so unmodeled OOXML
 * features (data binding, `w15:repeatingSection`, `@lastValue`, custom XML
 * mappings) round-trip losslessly — see ECMA-376 §17.5.2 (`CT_SdtPr` is an
 * `xsd:sequence` so element order matters; replaying the original XML
 * preserves it for free).
 */

import type { SdtProperties } from "../types/document";
import { SdtLockSchema, narrowEnum } from "./parserEnums";
import {
  elementToXml,
  findChild,
  getAttributeAnyPrefix,
  getLocalName,
  parseBooleanElement,
  type XmlElement,
} from "./xmlParser";

function parseListItems(
  el: XmlElement,
): { displayText: string; value: string }[] {
  const items: { displayText: string; value: string }[] = [];
  for (const child of el.elements ?? []) {
    if (
      child.type === "element" &&
      (child.name === "w:listItem" || child.name?.endsWith(":listItem"))
    ) {
      // OOXML §17.5.2.10: `w:displayText` is optional, and `w:value` is
      // optional too. Fall back each to the other so a partially specified
      // listItem stays selectable + visible — without this, the dropdown
      // shell renders a blank option and the value-set path writes an
      // empty paragraph for a real OOXML pick.
      //
      // Read attributes by the element's own prefix first (the spec lets
      // a producer bind the Word namespace under any prefix, e.g.
      // `<ns0:listItem ns0:displayText="A" ns0:value="a"/>`). The previous
      // hard-coded `w:` lookup turned every such item into `(null, null)`
      // and silently dropped it, so non-standard-prefix dropdowns opened
      // with no options.
      const displayText = getAttributeAnyPrefix(child, "displayText");
      const value = getAttributeAnyPrefix(child, "value");
      if (displayText === null && value === null) {
        continue;
      }
      items.push({
        displayText: displayText ?? value ?? "",
        value: value ?? displayText ?? "",
      });
    }
  }
  return items;
}

/**
 * Local names that always belong to one specific OOXML namespace. The
 * serializer's document root only declares the canonical `w` / `w14` /
 * `w15` prefixes, so any captured raw SDT child written under an
 * alternate prefix would replay as an undefined-prefix element (Word
 * refuses such files). We rewrite by element-local-name so an inherited
 * `<x:checkbox>` / `<y:repeatingSection>` (where `x` / `y` are bound to
 * the w14 / w15 URIs at the source's document root) always lands under
 * the canonical prefix in our output regardless of the source's prefix
 * choice.
 */
// Only local names that are UNAMBIGUOUSLY bound to one namespace make it
// in here. `color` and `appearance` would otherwise look identical to
// `<w:color>` inside a placeholder `<w:rPr>` and we'd silently rewrite
// run formatting as w15 SDT appearance, corrupting the parse → save
// round trip for any sdtPr that carries nested run properties.
//
// W_LOCAL_NAMES covers SDT property children that exist only in the
// WordprocessingML (w:) namespace by spec — `<x:tag>` inherited from
// the document root must mean `<w:tag>` because no other namespace
// defines that local name in a `<w:sdtPr>`/`<w:sdtEndPr>` context.
const W_LOCAL_NAMES = new Set([
  "alias",
  "tag",
  "id",
  "lock",
  "placeholder",
  "docPart",
  "showingPlcHdr",
  "text",
  "date",
  "dateFormat",
  "lid",
  "calendar",
  "storeMappedDataAs",
  "dropDownList",
  "listItem",
  "comboBox",
  "picture",
  "docPartObj",
  "docPartList",
  "docPartCategory",
  "docPartGallery",
  "docPartUnique",
  "group",
  "equation",
  "citation",
  "bibliography",
  "richText",
]);
const W14_LOCAL_NAMES = new Set(["checkbox", "checked"]);
const W15_LOCAL_NAMES = new Set(["repeatingSection", "repeatingSectionItem"]);

/**
 * Rewrite the captured raw `<*:sdtPr>` / `<*:sdtEndPr>` snippet so every
 * SDT-namespace element uses the canonical `w:` / `w14:` / `w15:`
 * prefix on save. The blockSdtSerializer's document root declares only
 * those three prefixes, so replaying a source snippet that uses an
 * alternate prefix (`<ns0:sdtPr>` with `xmlns:ns0` declared on the
 * source's `<w:document>`, or `<x:checkbox>` inside a canonical sdtPr)
 * would produce invalid XML in the saved DOCX — Word refuses files
 * with unresolved namespace prefixes.
 *
 * Heuristics, since fast-xml-parser does not surface namespace URIs in
 * preserveOrder mode:
 *
 * 1. If the captured wrapper element itself uses a non-`w` prefix, that
 *    prefix is taken to be bound to the WP URI (the source DOCX would
 *    otherwise be invalid) and ALL occurrences of it inside the snippet
 *    are rewritten to `w:`.
 * 2. After step 1, any remaining alt-prefix on an element whose local
 *    name is in W14_LOCAL_NAMES / W15_LOCAL_NAMES gets normalized to
 *    `w14:` / `w15:`. That handles a canonical `<w:sdtPr>` wrapper
 *    whose children inherit a non-`w14` / non-`w15` prefix from the
 *    source's document root.
 */
function normalizeWordPrefix(raw: string, source: XmlElement): string {
  let out = raw;
  // Step 1: wrapper prefix → canonical w.
  const name = source.name ?? "";
  const colonIdx = name.indexOf(":");
  if (colonIdx > 0) {
    const sourcePrefix = name.slice(0, colonIdx);
    if (sourcePrefix !== "w") {
      out = rewritePrefix(out, sourcePrefix, "w");
    }
  }
  // Step 2: child elements that live in known sibling namespaces.
  // - W_LOCAL_NAMES handles inherited alt-prefix SDT property children
  //   sitting inside a canonical `<w:sdtPr>` wrapper (case the pass-19
  //   wrapper-only fix missed).
  // - W14 / W15 sets handle the wider w14:checkbox / w15:repeatingSection
  //   children that don't share local names with run / paragraph
  //   formatting.
  out = normalizeChildrenForLocalNames(out, W_LOCAL_NAMES, "w");
  out = normalizeChildrenForLocalNames(out, W14_LOCAL_NAMES, "w14");
  out = normalizeChildrenForLocalNames(out, W15_LOCAL_NAMES, "w15");
  return out;
}

function rewritePrefix(raw: string, from: string, to: string): string {
  const escaped = from.replaceAll(/[$()*+./?[\\\]^{|}]/gu, "\\$&");
  const tagOpen = new RegExp(`<${escaped}:`, "gu");
  const tagClose = new RegExp(`</${escaped}:`, "gu");
  const attr = new RegExp(`(\\s)${escaped}:`, "gu");
  return raw
    .replaceAll(tagOpen, `<${to}:`)
    .replaceAll(tagClose, `</${to}:`)
    .replaceAll(attr, `$1${to}:`);
}

function normalizeChildrenForLocalNames(
  raw: string,
  localNames: ReadonlySet<string>,
  canonical: string,
): string {
  let out = raw;
  // For each local name, find any `<prefix:localName` and `</prefix:localName>`
  // whose prefix is NOT already canonical, and swap that prefix to canonical.
  // The `\b` after the local name keeps `<prefix:checkboxFoo>` from matching.
  for (const local of localNames) {
    const escapedLocal = local.replaceAll(/[$()*+./?[\\\]^{|}]/gu, "\\$&");
    const opener = new RegExp(`<(\\w+):${escapedLocal}\\b`, "gu");
    const closer = new RegExp(`</(\\w+):${escapedLocal}\\b`, "gu");
    out = out.replaceAll(opener, (_m, prefix: string) =>
      prefix === canonical ? `<${prefix}:${local}` : `<${canonical}:${local}`,
    );
    out = out.replaceAll(closer, (_m, prefix: string) =>
      prefix === canonical ? `</${prefix}:${local}` : `</${canonical}:${local}`,
    );
    // Normalize attribute-name prefixes on the targeted element. Regex-only
    // approaches don't track quote state, so `[^>]{0,200}\s(\w+):` would
    // greedily consume past a quoted attribute value boundary and rewrite
    // a prefix-shaped token sitting *inside* the value
    // (e.g. `<w:tag w:val="foo od:repeat=x0"/>` → `w:val="foo w:repeat=x0"`).
    // Walk the open tag instead, tracking quote state so the rewrite only
    // fires at real attribute-name positions.
    out = rewriteOpenTagAttrPrefixes(out, canonical, local);
  }
  return out;
}

/**
 * Walk every `<canonical:local …>` open tag in `raw` and rewrite any
 * attribute-name prefix that is not already `canonical` (and not `xmlns`) to
 * `canonical`. Quoted attribute values are skipped so prefix-shaped substrings
 * inside a value (OpenDoPE payloads in `w:tag w:val="…"`, namespace URIs in
 * `xmlns:foo="…"`, etc.) are left untouched.
 */
function rewriteOpenTagAttrPrefixes(
  raw: string,
  canonical: string,
  local: string,
): string {
  const opener = `<${canonical}:${local}`;
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const tagStart = raw.indexOf(opener, cursor);
    if (tagStart === -1) {
      pieces.push(raw.slice(cursor));
      break;
    }
    // Require a word boundary after the opener so `<w:checkbox` does not
    // also match `<w:checkboxFoo`.
    const afterOpener = raw.codePointAt(tagStart + opener.length);
    const isBoundary =
      afterOpener === undefined ||
      !(
        (
          (afterOpener >= 0x30 && afterOpener <= 0x39) || // 0-9
          (afterOpener >= 0x41 && afterOpener <= 0x5a) || // A-Z
          (afterOpener >= 0x61 && afterOpener <= 0x7a) || // a-z
          afterOpener === 0x5f
        ) // _
      );
    if (!isBoundary) {
      pieces.push(raw.slice(cursor, tagStart + opener.length));
      cursor = tagStart + opener.length;
      continue;
    }
    pieces.push(raw.slice(cursor, tagStart + opener.length));
    cursor = tagStart + opener.length;
    // Walk the open tag to its closing `>`, tracking quote state. Attribute
    // names always sit outside quotes; prefix-shaped tokens inside quotes are
    // attribute values and must be preserved verbatim.
    let quote: '"' | "'" | null = null;
    let atAttrNameBoundary = true;
    while (cursor < raw.length) {
      const ch = raw.charAt(cursor);
      if (quote) {
        pieces.push(ch);
        cursor += 1;
        if (ch === quote) {
          quote = null;
          // Whitespace between attributes must precede the next attribute
          // name; flagging the boundary keeps the rewrite anchored to real
          // attribute-name positions.
          atAttrNameBoundary = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        pieces.push(ch);
        cursor += 1;
        continue;
      }
      if (ch === ">") {
        pieces.push(ch);
        cursor += 1;
        break;
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        pieces.push(ch);
        cursor += 1;
        atAttrNameBoundary = true;
        continue;
      }
      if (atAttrNameBoundary) {
        // Read the next token until `=`, whitespace, `/`, or `>`. If it
        // matches `prefix:localAttr` with a non-canonical, non-xmlns prefix,
        // rewrite the prefix.
        const tokenStart = cursor;
        while (cursor < raw.length) {
          const c = raw.charAt(cursor);
          if (
            c === "=" ||
            c === " " ||
            c === "\t" ||
            c === "\n" ||
            c === "\r" ||
            c === "/" ||
            c === ">"
          ) {
            break;
          }
          cursor += 1;
        }
        const token = raw.slice(tokenStart, cursor);
        const colonIdx = token.indexOf(":");
        if (colonIdx > 0) {
          const prefix = token.slice(0, colonIdx);
          const localAttr = token.slice(colonIdx + 1);
          if (
            prefix !== canonical &&
            prefix !== "xmlns" &&
            /^\w+$/u.test(prefix) &&
            localAttr.length > 0
          ) {
            pieces.push(`${canonical}:${localAttr}`);
          } else {
            pieces.push(token);
          }
        } else {
          pieces.push(token);
        }
        atAttrNameBoundary = false;
        continue;
      }
      // Outside quotes, not at an attribute-name boundary — must be the `=`
      // or stray characters before a quoted value. Copy verbatim.
      pieces.push(ch);
      cursor += 1;
    }
  }
  return pieces.join("");
}

/**
 * Parse `<w:sdtPr>` (and optional `<w:sdtEndPr>`) into {@link SdtProperties}.
 *
 * Modeled fields drive addressing / template tooling; `rawPropertiesXml`
 * and `rawEndPropertiesXml` carry the original bytes for the serializer to
 * replay unchanged, so the projection only needs to handle what we
 * actually consume — unmodeled markers are not silently dropped.
 */
export function parseSdtProperties(
  sdtPr: XmlElement | null | undefined,
  sdtEndPr?: XmlElement | null | undefined,
): SdtProperties {
  const props: SdtProperties = { sdtType: "richText" };

  if (sdtPr) {
    props.rawPropertiesXml = normalizeWordPrefix(elementToXml(sdtPr), sdtPr);

    for (const el of sdtPr.elements ?? []) {
      if (el.type !== "element") {
        continue;
      }
      // The checkbox marker is `w14:checkbox`, not `w:checkbox`; strip *any*
      // namespace prefix so non-`w:` SDT property elements (w14, w15, ...)
      // route to the right case instead of falling through to default and
      // misclassifying the control as richText.
      const name = el.name ? getLocalName(el.name) : "";

      switch (name) {
        case "id": {
          const raw = getAttributeAnyPrefix(el, "val");
          if (raw !== null) {
            const n = Number.parseInt(raw, 10);
            if (!Number.isNaN(n)) {
              props.id = n;
            }
          }
          break;
        }
        case "alias": {
          const aliasVal = getAttributeAnyPrefix(el, "val");
          if (aliasVal !== null) {
            props.alias = aliasVal;
          }
          break;
        }
        case "tag": {
          const tagVal = getAttributeAnyPrefix(el, "val");
          if (tagVal !== null) {
            props.tag = tagVal;
          }
          break;
        }
        case "lock": {
          const lockVal = getAttributeAnyPrefix(el, "val");
          props.lock = narrowEnum(lockVal, SdtLockSchema) ?? "unlocked";
          break;
        }
        case "placeholder": {
          // OOXML §17.5.2.27: the placeholder reference is an attribute
          // on `<w:docPart>` itself (`<w:docPart w:val="…"/>`), not a
          // nested `<w:val>` child. We previously looked for a child
          // `<w:val>`, so `props.placeholder` was never populated on
          // parse — getContentControls() and reverse serialization lost
          // the placeholder metadata entirely.
          const docPart = findChild(el, "w", "docPart");
          if (docPart) {
            const phVal = getAttributeAnyPrefix(docPart, "val");
            if (phVal !== null) {
              props.placeholder = phVal;
            }
          }
          break;
        }
        case "showingPlcHdr":
          // OOXML OnOff: element presence with no val attribute means
          // true; val="0" / "false" / "off" means false. Source DOCXs
          // rarely write the negation explicitly (Word typically omits
          // the element when not showing placeholder), but the
          // serializer's `reconcileRawSdtPr` round-trip can produce one
          // and we shouldn't silently flip its semantics.
          props.showingPlaceholder = parseBooleanElement(el, "w");
          break;
        case "text":
          props.sdtType = "plainText";
          break;
        case "date": {
          props.sdtType = "date";
          // The display format lives in the child <w:dateFormat w:val="..."/>;
          // the bound value is in the parent's <w:date w:fullDate="..."/>.
          const dateFormatEl = findChild(el, "w", "dateFormat");
          if (dateFormatEl) {
            const fmt = getAttributeAnyPrefix(dateFormatEl, "val");
            if (fmt !== null) {
              props.dateFormat = fmt;
            }
          }
          const fullDate = getAttributeAnyPrefix(el, "fullDate");
          if (fullDate !== null) {
            props.dateValueISO = fullDate;
          }
          break;
        }
        case "dropDownList":
        case "comboBox": {
          props.sdtType = name === "dropDownList" ? "dropdown" : "comboBox";
          props.listItems = parseListItems(el);
          // Capture the source's `w:lastValue` so a parse → save round trip
          // for a dropdown that was previously chosen in Word keeps the
          // exact OOXML value, even if duplicate displayText would have
          // made the body-text fallback ambiguous.
          const lastValue = getAttributeAnyPrefix(el, "lastValue");
          if (lastValue !== null) {
            props.dropdownLastValue = lastValue;
          }
          break;
        }
        case "checkbox": {
          props.sdtType = "checkbox";
          // OOXML OnOff values are "1" | "true" | "on" (or absent attribute
          // meaning true); their negations are "0" | "false" | "off".
          // `parseBooleanElement` already encapsulates that vs. our previous
          // strict `=== "1"` check, which misclassified Word's `val="true"`
          // and bare `<w14:checked/>` forms as unchecked.
          const checked14 = findChild(el, "w14", "checked");
          const checkedW = findChild(el, "w", "checked");
          if (checked14) {
            props.checked = parseBooleanElement(checked14, "w14");
          } else if (checkedW) {
            props.checked = parseBooleanElement(checkedW, "w");
          } else {
            props.checked = false;
          }
          break;
        }
        case "picture":
          props.sdtType = "picture";
          break;
        case "docPartObj":
        case "docPartList":
          props.sdtType = "buildingBlockGallery";
          break;
        case "group":
          props.sdtType = "group";
          break;
        default:
          // Unmodeled markers (equation, citation, bibliography, w15:*) fall
          // through; `rawPropertiesXml` carries them verbatim for round-trip.
          break;
      }
    }
  }

  if (sdtEndPr) {
    props.rawEndPropertiesXml = normalizeWordPrefix(
      elementToXml(sdtEndPr),
      sdtEndPr,
    );
  }

  return props;
}
