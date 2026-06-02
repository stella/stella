/**
 * Surgical patches for the captured `<w:sdtPr>` XML string.
 *
 * Background. The block-SDT serializer (commit 3) replays
 * `properties.rawPropertiesXml` verbatim so unmodeled OOXML markers
 * (`w:dataBinding`, `w15:repeatingSection`, custom XML mappings) survive
 * a round trip. That replay is correct for unchanged controls but goes
 * stale the moment the editor mutates a modeled property: a user
 * toggling a checkbox, picking a date, or choosing a dropdown value
 * updates `properties.checked` / `dateFormat` / etc., but the raw
 * `w14:checked w14:val="0"` already encoded by the source DOCX stays
 * in `rawPropertiesXml` and gets written back on save — Word reopens
 * the document with the user's interactive change discarded.
 *
 * `reconcileRawSdtPr` walks every modeled field that has an OOXML
 * representation inside `<w:sdtPr>` and, if the field is set on the
 * model, rewrites the matching element in the raw string. Unmodeled
 * markers are untouched, so dataBinding / repeatingSection round-trip
 * stays lossless even after the user has mutated the control.
 *
 * Picked up from upstream eigenpal/docx-editor#661.
 */

import type { SdtProperties } from "../types/document";

const XML_ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escape a value for embedding in an XML attribute. Single-pass replace
 * over the five XML metacharacters (incl. apostrophe so the function
 * stays correct for `'`-delimited attributes even though this file always
 * emits double-quoted ones). Output is XML written to a DOCX zip — no
 * HTML / browser interpretation downstream.
 */
function escapeXmlAttr(value: string): string {
  return value.replace(/[&<>"']/gu, (ch) => XML_ATTR_ESCAPES[ch] ?? ch);
}

/**
 * Drop any `*:lastValue="…"` attribute (any namespace prefix, or
 * unprefixed) from an attribute-list string. We avoid a single greedy
 * regex with `\s+` (which lint flags as backtracking-risky) and instead
 * scan character-by-character against `lastValue=` while accepting any
 * preceding `prefix:`. Without prefix tolerance, a source DOCX that
 * binds the Word namespace under a non-`w` prefix
 * (`<ns0:dropDownList ns0:lastValue="old">`) would keep the stale
 * attribute alongside our freshly-emitted `w:lastValue` on save.
 */
function stripLastValueAttr(attrs: string): string {
  const SUFFIX = "lastValue=";
  let out = attrs;
  let searchFrom = 0;
  while (searchFrom < out.length) {
    const hitIdx = out.indexOf(SUFFIX, searchFrom);
    if (hitIdx === -1) {
      break;
    }
    // Walk backwards over an optional `prefix:` and require a leading
    // whitespace separator so we don't accidentally chew on an attr like
    // `mylastValue=`. The attribute we want is always introduced by
    // whitespace.
    let nameStart = hitIdx;
    while (nameStart > 0 && /[A-Za-z0-9_-]/u.test(out[nameStart - 1] ?? "")) {
      nameStart -= 1;
    }
    if (nameStart > 0 && out[nameStart - 1] === ":") {
      nameStart -= 1;
      while (nameStart > 0 && /[A-Za-z0-9_-]/u.test(out[nameStart - 1] ?? "")) {
        nameStart -= 1;
      }
    }
    if (nameStart === 0 || !/\s/u.test(out[nameStart - 1] ?? "")) {
      searchFrom = hitIdx + SUFFIX.length;
      continue;
    }
    const quoteIdx = hitIdx + SUFFIX.length;
    const quote = out[quoteIdx];
    if (quote !== '"' && quote !== "'") {
      searchFrom = hitIdx + SUFFIX.length;
      continue;
    }
    const closeIdx = out.indexOf(quote, quoteIdx + 1);
    if (closeIdx === -1) {
      break;
    }
    // Drop the leading separator too so two whitespace runs don't merge.
    out = `${out.slice(0, nameStart - 1)}${out.slice(closeIdx + 1)}`;
    searchFrom = nameStart - 1;
  }
  return out;
}

/**
 * Replace or insert a child element inside `<w:sdtPr>...</w:sdtPr>`.
 *
 * - If a matching child already exists (by local name), the whole element
 *   is replaced verbatim by `replacement` (so attributes / payload come
 *   from the caller).
 * - Otherwise `replacement` is injected just before `</w:sdtPr>` so the
 *   element ends up as a child of sdtPr, not after it.
 */
function upsertSdtPrChild(
  raw: string,
  localName: string,
  replacement: string,
): string {
  // Match `<prefix:localName ... />` or `<prefix:localName ...>...</prefix:localName>`.
  const escaped = localName.replaceAll(/[$()*+./?[\\\]^{|}]/gu, "\\$&");
  const selfClosing = new RegExp(`<\\w+:${escaped}\\b[^>]*\\/>`, "iu");
  const opened = new RegExp(
    `<\\w+:${escaped}\\b[^>]*>[\\s\\S]*?<\\/\\w+:${escaped}>`,
    "iu",
  );
  if (selfClosing.test(raw)) {
    return raw.replace(selfClosing, replacement);
  }
  if (opened.test(raw)) {
    return raw.replace(opened, replacement);
  }
  // Inject before the matching closing tag. Capture the source prefix and
  // reuse it for the rewritten closing tag so an exotic namespace prefix
  // (`<ns0:sdtPr>...</ns0:sdtPr>`) doesn't end up with a mismatched
  // `</w:sdtPr>` — the resulting XML would be malformed and Word would
  // refuse the file.
  const closing = /<\/(\w+):sdtPr>/iu;
  const closingMatch = closing.exec(raw);
  if (closingMatch) {
    const closingPrefix = closingMatch[1];
    return raw.replace(closing, `${replacement}</${closingPrefix}:sdtPr>`);
  }
  // Self-closing `<w:sdtPr/>` — expand to a container.
  const selfClosingPr = /<(\w+):sdtPr([^/>]*)\/>/iu;
  if (selfClosingPr.test(raw)) {
    return raw.replace(
      selfClosingPr,
      (_match, prefix: string, attrs: string) =>
        `<${prefix}:sdtPr${attrs}>${replacement}</${prefix}:sdtPr>`,
    );
  }
  return raw;
}

function setOrRemove(
  raw: string,
  localName: string,
  replacementWhenSet: string | null,
): string {
  if (replacementWhenSet === null) {
    // Remove any existing element of that name; tolerate prefixed forms.
    const escaped = localName.replaceAll(/[$()*+./?[\\\]^{|}]/gu, "\\$&");
    const selfClosing = new RegExp(`<\\w+:${escaped}\\b[^>]*\\/>`, "igu");
    const opened = new RegExp(
      `<\\w+:${escaped}\\b[^>]*>[\\s\\S]*?<\\/\\w+:${escaped}>`,
      "igu",
    );
    return raw.replaceAll(selfClosing, "").replaceAll(opened, "");
  }
  return upsertSdtPrChild(raw, localName, replacementWhenSet);
}

/**
 * Rewrite the relevant child elements of `<w:sdtPr>` so the modeled
 * properties (checked / dateFormat / fullDate / lastValue / showingPlcHdr)
 * agree with the raw XML before it is replayed by the serializer.
 *
 * Pure: returns a new string; the input is not modified.
 */
export function reconcileRawSdtPr(
  raw: string,
  props: SdtProperties,
  options: { dateFullDate?: string; dropdownLastValue?: string } = {},
): string {
  let next = raw;

  // showingPlcHdr is a marker element; toggle it based on the boolean.
  if (props.showingPlaceholder === true) {
    next = setOrRemove(next, "showingPlcHdr", "<w:showingPlcHdr/>");
  } else if (props.showingPlaceholder === false) {
    next = setOrRemove(next, "showingPlcHdr", null);
  }

  // Checkbox state lives in <w14:checkbox><w14:checked w14:val="0|1"/>...
  // For OOXML compatibility we keep the w14 prefix; Word writes this form
  // for checkboxes authored since Word 2010.
  if (props.sdtType === "checkbox" && typeof props.checked === "boolean") {
    const val = props.checked ? "1" : "0";
    // Handle the expanded-empty form `<w14:checked ...></w14:checked>` first
    // so we replace the whole element, not just the opening tag (which
    // would leave a stray closing tag behind). Then the self-closing
    // form, then folding into an existing <w14:checkbox> wrapper, then a
    // synthesized wrapper as the last resort.
    const checkedOpened = /<(\w+):checked\b[^>]*>[\s\S]*?<\/\w+:checked>/iu;
    const checkedSelfClosing = /<(\w+):checked\b[^>]*\/>/iu;
    if (checkedOpened.test(next)) {
      next = next.replaceAll(
        /<(\w+):checked\b[^>]*>[\s\S]*?<\/\w+:checked>/giu,
        (_m, prefix: string) => `<${prefix}:checked ${prefix}:val="${val}"/>`,
      );
    } else if (checkedSelfClosing.test(next)) {
      next = next.replaceAll(
        /<(\w+):checked\b[^>]*\/>/giu,
        (_m, prefix: string) => `<${prefix}:checked ${prefix}:val="${val}"/>`,
      );
    } else if (/<\w+:checkbox\b[^>]*>/iu.test(next)) {
      next = next.replace(
        /<(\w+):checkbox\b[^>]*>/iu,
        (match, prefix: string) =>
          `${match}<${prefix}:checked ${prefix}:val="${val}"/>`,
      );
    } else {
      next = upsertSdtPrChild(
        next,
        "checkbox",
        `<w14:checkbox><w14:checked w14:val="${val}"/></w14:checkbox>`,
      );
    }
  }

  // Date format: <w:date w:fullDate="..."><w:dateFormat w:val="..."/>...
  // We only own the modeled fields here — leave any other w:date children
  // (lid, calendar, storeMappedDataAs) alone.
  if (props.sdtType === "date") {
    const fullDate = options.dateFullDate;
    const dateFormat = props.dateFormat;
    if (fullDate !== undefined || dateFormat !== undefined) {
      // Patch <w:date> in place when present, otherwise insert a fresh one.
      const wDate = /<(\w+):date\b([^>]*)>([\s\S]*?)<\/\w+:date>/iu;
      const wDateSelf = /<(\w+):date\b([^/>]*)\/>/iu;
      const fullDateAttr =
        fullDate !== undefined
          ? ` w:fullDate="${escapeXmlAttr(fullDate)}"`
          : "";
      const formatChild =
        dateFormat !== undefined
          ? `<w:dateFormat w:val="${escapeXmlAttr(dateFormat)}"/>`
          : "";
      if (wDate.test(next)) {
        next = next.replace(
          wDate,
          (_m, prefix: string, _attrs: string, inner: string) => {
            // Remove any existing w:dateFormat, re-emit ours if provided.
            // Match BOTH the self-closing and expanded-empty forms — a valid
            // DOCX is free to write `<w:dateFormat w:val="…"></w:dateFormat>`,
            // and stripping only `…/>` would leave a stale sibling next to
            // the freshly-prepended replacement on the next save.
            let body = inner
              .replaceAll(/<\w+:dateFormat\b[^/>]*\/>/giu, "")
              .replaceAll(
                /<\w+:dateFormat\b[^>]*>[\s\S]*?<\/\w+:dateFormat>/giu,
                "",
              );
            if (formatChild) {
              body = `${formatChild}${body}`;
            }
            const attrs = fullDate !== undefined ? fullDateAttr : _attrs;
            return `<${prefix}:date${attrs}>${body}</${prefix}:date>`;
          },
        );
      } else if (wDateSelf.test(next)) {
        next = next.replace(
          wDateSelf,
          (_m, prefix: string) =>
            `<${prefix}:date${fullDateAttr}>${formatChild}</${prefix}:date>`,
        );
      } else {
        next = upsertSdtPrChild(
          next,
          "date",
          `<w:date${fullDateAttr}>${formatChild}</w:date>`,
        );
      }
    }
  }

  // Dropdown selection: <w:dropDownList w:lastValue="..."><w:listItem .../>
  // Preserve the listItem children; we only touch the @w:lastValue attribute.
  if (
    (props.sdtType === "dropdown" || props.sdtType === "comboBox") &&
    options.dropdownLastValue !== undefined
  ) {
    const escapedValue = escapeXmlAttr(options.dropdownLastValue);
    const opened =
      /<(\w+):(dropDownList|comboBox)\b([^>]*)>([\s\S]*?)<\/\w+:(?:dropDownList|comboBox)>/iu;
    const selfClosing = /<(\w+):(dropDownList|comboBox)\b([^/>]*)\/>/iu;
    if (opened.test(next)) {
      next = next.replace(
        opened,
        (_m, prefix: string, name: string, attrs: string, inner: string) => {
          const stripped = stripLastValueAttr(attrs);
          // Re-emit under the SOURCE prefix so a producer that bound w:
          // under `ns0` ends up with `ns0:lastValue` rather than mixing
          // prefixes inside the same element.
          return `<${prefix}:${name}${stripped} ${prefix}:lastValue="${escapedValue}">${inner}</${prefix}:${name}>`;
        },
      );
    } else if (selfClosing.test(next)) {
      next = next.replace(
        selfClosing,
        (_m, prefix: string, name: string, attrs: string) => {
          const stripped = stripLastValueAttr(attrs);
          return `<${prefix}:${name}${stripped} ${prefix}:lastValue="${escapedValue}"/>`;
        },
      );
    }
  }

  return next;
}
