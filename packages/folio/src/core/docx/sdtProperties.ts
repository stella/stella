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
    props.rawPropertiesXml = elementToXml(sdtPr);

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
    props.rawEndPropertiesXml = elementToXml(sdtEndPr);
  }

  return props;
}
