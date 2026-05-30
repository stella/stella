/**
 * OMML → MathML conversion.
 *
 * Office Math Markup Language (OMML, namespace
 * `http://schemas.openxmlformats.org/officeDocument/2006/math`) is what
 * `<m:oMath>` / `<m:oMathPara>` carry inside `.docx`. OMML and MathML cover
 * the same equation primitives, and Microsoft ships an XSLT
 * (`OMML2MML.XSL`) that maps the two for Office's "save as MathML" feature.
 *
 * This module is a focused TypeScript implementation that walks the parsed
 * XML tree produced by folio's parser (`XmlElement` from `./xmlParser`) and
 * emits a MathML XML string suitable for direct injection into the DOM via
 * `innerHTML` on a `<math>` host element. All Tier 1 desktop browsers
 * render MathML Core natively (Firefox, Safari, Chromium ≥ 24 — Igalia's
 * MathML revival shipped in Chrome 109, 2023), so the painter does not need
 * KaTeX or MathJax on top.
 *
 * Coverage targets the OMML elements that appear in legal-doc and
 * expert-report use cases: fractions, sub/superscripts, n-ary operators
 * (Σ ∫ ∏ ⋃), radicals, delimiters, matrices, accents, plus the run/text
 * primitives. Unknown OMML elements degrade to a `<mrow>` of their
 * children rather than dropping content.
 *
 * Structural mapping is informed by Microsoft's public OMML2MML.XSL
 * (BSD-style licence) — we borrow the element correspondence table but
 * implement against folio's own `XmlElement` rather than vendoring the
 * stylesheet.
 */

import {
  type XmlElement,
  findChildByLocalName,
  getLocalName,
} from "./xmlParser";

/**
 * Convert an OMML element (`<m:oMath>` or `<m:oMathPara>`) into a MathML
 * XML string.
 *
 * The returned string is the full `<math>...</math>` element including the
 * MathML namespace, ready to set via `Element.innerHTML` or
 * `Range.createContextualFragment`. Returns `null` if `omml` is not an
 * OMML root element or contains no convertible children.
 */
export function ommlToMathml(omml: XmlElement): string | null {
  const local = omml.name ? getLocalName(omml.name) : "";
  if (local !== "oMath" && local !== "oMathPara") {
    return null;
  }

  const isBlock = local === "oMathPara";

  // `<m:oMathPara>` wraps one or more `<m:oMath>` children plus
  // paragraph properties (`<m:oMathParaPr>`). Convert every contained
  // oMath child; if none exist, fall through to the generic mrow path.
  let bodyMathml: string;
  if (isBlock) {
    const oMathChildren = (omml.elements ?? []).filter(
      (child) =>
        child.type === "element" && getLocalName(child.name ?? "") === "oMath",
    );
    if (oMathChildren.length > 0) {
      bodyMathml = oMathChildren.map((child) => renderChildren(child)).join("");
    } else {
      bodyMathml = renderChildren(omml);
    }
  } else {
    bodyMathml = renderChildren(omml);
  }

  if (!bodyMathml) {
    return null;
  }

  const displayAttr = isBlock ? ' display="block"' : "";
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttr}>${bodyMathml}</math>`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MATH_OPERATOR_HINT = new Set<string>([
  "+",
  "-",
  "=",
  "<",
  ">",
  "≤",
  "≥",
  "≠",
  "±",
  "×",
  "÷",
  "·",
  "∙",
  "/",
  "*",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  ",",
  ";",
  ":",
  "→",
  "←",
  "↔",
  "⇒",
  "⇐",
  "∈",
  "∉",
  "⊂",
  "⊃",
  "∪",
  "∩",
  "∀",
  "∃",
  "∂",
  "∇",
  "∞",
  "…",
]);

function renderElement(el: XmlElement): string {
  if (el.type === "text") {
    return escapeXml(textValue(el));
  }
  if (el.type !== "element") {
    return "";
  }

  const local = el.name ? getLocalName(el.name) : "";
  switch (local) {
    case "oMath":
    case "oMathPara":
      return renderChildren(el);
    case "r":
      return renderRun(el);
    case "t":
      return escapeXml(extractText(el));
    case "f":
      return renderFraction(el);
    case "num":
    case "den":
      return wrapMrow(renderChildren(el));
    case "sSup":
      return renderScript(el, "msup");
    case "sSub":
      return renderScript(el, "msub");
    case "sSubSup":
      return renderSubSup(el);
    case "sPre":
      return renderPreScript(el);
    case "rad":
      return renderRadical(el);
    case "deg":
    case "e":
    case "sup":
    case "sub":
    case "fName":
    case "lim":
      return wrapMrow(renderChildren(el));
    case "nary":
      return renderNary(el);
    case "d":
      return renderDelimiter(el);
    case "m":
      return renderMatrix(el);
    case "mr":
      return renderMatrixRow(el);
    case "acc":
      return renderAccent(el);
    case "bar":
      return renderBar(el);
    case "groupChr":
      return renderGroupChr(el);
    case "limLow":
      return renderLimLow(el);
    case "limUpp":
      return renderLimUpp(el);
    case "func":
      return renderChildren(el);
    case "box":
    case "borderBox":
    case "eqArr":
      // Best-effort: render children inline; no first-class MathML for these.
      return wrapMrow(renderChildren(el));
    case "rPr":
    case "ctrlPr":
    case "fPr":
    case "naryPr":
    case "dPr":
    case "rPrChange":
    case "mPr":
    case "accPr":
    case "barPr":
    case "groupChrPr":
    case "limLowPr":
    case "limUppPr":
    case "sSupPr":
    case "sSubPr":
    case "sSubSupPr":
    case "sPrePr":
    case "radPr":
    case "boxPr":
    case "borderBoxPr":
    case "eqArrPr":
    case "oMathParaPr":
    case "funcPr":
      // Property elements carry presentation hints we ignore today.
      return "";
    default:
      // Unknown OMML elements degrade to their children so content is not
      // silently dropped.
      return renderChildren(el);
  }
}

function renderChildren(el: XmlElement): string {
  if (!el.elements) {
    return "";
  }
  let out = "";
  for (const child of el.elements) {
    out += renderElement(child);
  }
  return out;
}

/**
 * Convert an `<m:r>` run into a sequence of `<mi>` / `<mn>` / `<mo>`
 * tokens. OMML stores math text in `<m:t>`; we tokenise on
 * letter/digit/operator transitions to mirror MathML's per-token model.
 */
function renderRun(run: XmlElement): string {
  const tElems = (run.elements ?? []).filter(
    (c) => c.type === "element" && getLocalName(c.name ?? "") === "t",
  );
  if (tElems.length === 0) {
    return "";
  }
  let out = "";
  for (const tEl of tElems) {
    out += tokenizeMathText(extractText(tEl));
  }
  return out;
}

function tokenizeMathText(text: string): string {
  if (!text) {
    return "";
  }
  let out = "";
  let buf = "";
  let bufKind: "letter" | "digit" | null = null;
  const flush = () => {
    if (!buf) {
      return;
    }
    if (bufKind === "digit") {
      out += `<mn>${escapeXml(buf)}</mn>`;
    } else {
      out += `<mi>${escapeXml(buf)}</mi>`;
    }
    buf = "";
    bufKind = null;
  };
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\n") {
      flush();
      out += '<mspace width="0.2em"/>';
      continue;
    }
    const kind = classifyChar(ch);
    if (kind === "operator") {
      flush();
      out += `<mo>${escapeXml(ch)}</mo>`;
      continue;
    }
    if (kind === "digit") {
      // No mixed letter/digit buffer to flush — letters are emitted
      // immediately below, so when we get here bufKind is either null
      // or already "digit".
      bufKind = "digit";
      buf += ch;
      continue;
    }
    // letter / identifier: each letter is its own <mi> token per MathML
    // convention (variables are single-letter).
    flush();
    out += `<mi>${escapeXml(ch)}</mi>`;
  }
  flush();
  return out;
}

function classifyChar(ch: string): "letter" | "digit" | "operator" {
  if (ch >= "0" && ch <= "9") {
    return "digit";
  }
  if (ch === ".") {
    // Decimal point — sticks to surrounding numerals so "3.14" stays one <mn>.
    return "digit";
  }
  if (MATH_OPERATOR_HINT.has(ch)) {
    return "operator";
  }
  // Letter (Latin + Greek + Hebrew + other identifier-ish Unicode).
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x00_41 && code <= 0x00_5a) || // A-Z
    (code >= 0x00_61 && code <= 0x00_7a) || // a-z
    (code >= 0x03_91 && code <= 0x03_a9) || // Greek capital
    (code >= 0x03_b1 && code <= 0x03_c9) || // Greek small
    (code >= 0x05_d0 && code <= 0x05_ea) || // Hebrew letters
    (code >= 0x21_00 && code <= 0x21_4f) || // Letterlike Symbols
    (code >= 0x01_d4_00 && code <= 0x01_d7_ff) // Mathematical Alphanumeric Symbols
  ) {
    return "letter";
  }
  // Default: treat as operator (covers punctuation, arrows, set symbols).
  return "operator";
}

function renderFraction(el: XmlElement): string {
  const num = findChildByLocalName(el, "num");
  const den = findChildByLocalName(el, "den");
  const numMml = num ? wrapMrow(renderChildren(num)) : "<mrow/>";
  const denMml = den ? wrapMrow(renderChildren(den)) : "<mrow/>";
  const fPr = findChildByLocalName(el, "fPr");
  const typeEl = fPr ? findChildByLocalName(fPr, "type") : null;
  const type = typeEl ? getAttrValue(typeEl, "val") : null;
  const attrs = type === "noBar" ? ' linethickness="0"' : "";
  return `<mfrac${attrs}>${numMml}${denMml}</mfrac>`;
}

function renderScript(el: XmlElement, tag: "msup" | "msub"): string {
  const base = findChildByLocalName(el, "e");
  const script = findChildByLocalName(el, tag === "msup" ? "sup" : "sub");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  const scriptMml = script ? wrapMrow(renderChildren(script)) : "<mrow/>";
  return `<${tag}>${baseMml}${scriptMml}</${tag}>`;
}

function renderSubSup(el: XmlElement): string {
  const base = findChildByLocalName(el, "e");
  const sub = findChildByLocalName(el, "sub");
  const sup = findChildByLocalName(el, "sup");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  const subMml = sub ? wrapMrow(renderChildren(sub)) : "<mrow/>";
  const supMml = sup ? wrapMrow(renderChildren(sup)) : "<mrow/>";
  return `<msubsup>${baseMml}${subMml}${supMml}</msubsup>`;
}

function renderPreScript(el: XmlElement): string {
  const base = findChildByLocalName(el, "e");
  const sub = findChildByLocalName(el, "sub");
  const sup = findChildByLocalName(el, "sup");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  const subMml = sub ? wrapMrow(renderChildren(sub)) : "<none/>";
  const supMml = sup ? wrapMrow(renderChildren(sup)) : "<none/>";
  return `<mmultiscripts>${baseMml}<mprescripts/>${subMml}${supMml}</mmultiscripts>`;
}

function renderRadical(el: XmlElement): string {
  const deg = findChildByLocalName(el, "deg");
  const radicand = findChildByLocalName(el, "e");
  const radMml = radicand ? wrapMrow(renderChildren(radicand)) : "<mrow/>";
  // OMML uses `<m:radPr><m:degHide m:val="1"/></m:radPr>` or an empty
  // `<m:deg/>` to mean "no degree" — render `<msqrt>` in that case.
  const degText = deg ? renderChildren(deg) : "";
  if (!deg || !degText) {
    return `<msqrt>${radMml}</msqrt>`;
  }
  return `<mroot>${radMml}${wrapMrow(degText)}</mroot>`;
}

function renderNary(el: XmlElement): string {
  const sub = findChildByLocalName(el, "sub");
  const sup = findChildByLocalName(el, "sup");
  const body = findChildByLocalName(el, "e");

  // The operator character lives in `<m:naryPr><m:chr m:val="∑"/>`. Default
  // to ∫ per OMML spec (the implicit char when chr is absent).
  const naryPr = findChildByLocalName(el, "naryPr");
  const chrEl = naryPr ? findChildByLocalName(naryPr, "chr") : null;
  const chr = (chrEl ? getAttrValue(chrEl, "val") : null) || "∫";
  const limLocEl = naryPr ? findChildByLocalName(naryPr, "limLoc") : null;
  const limLoc = (limLocEl ? getAttrValue(limLocEl, "val") : null) || "subSup";

  const opMml = `<mo>${escapeXml(chr)}</mo>`;
  const subMml = sub ? wrapMrow(renderChildren(sub)) : "";
  const supMml = sup ? wrapMrow(renderChildren(sup)) : "";
  const bodyMml = body ? wrapMrow(renderChildren(body)) : "<mrow/>";

  let nary: string;
  if (subMml && supMml) {
    nary =
      limLoc === "undOvr"
        ? `<munderover>${opMml}${subMml}${supMml}</munderover>`
        : `<msubsup>${opMml}${subMml}${supMml}</msubsup>`;
  } else if (subMml) {
    nary =
      limLoc === "undOvr"
        ? `<munder>${opMml}${subMml}</munder>`
        : `<msub>${opMml}${subMml}</msub>`;
  } else if (supMml) {
    nary =
      limLoc === "undOvr"
        ? `<mover>${opMml}${supMml}</mover>`
        : `<msup>${opMml}${supMml}</msup>`;
  } else {
    nary = opMml;
  }

  return `<mrow>${nary}${bodyMml}</mrow>`;
}

function renderDelimiter(el: XmlElement): string {
  const dPr = findChildByLocalName(el, "dPr");
  const begChrEl = dPr ? findChildByLocalName(dPr, "begChr") : null;
  const endChrEl = dPr ? findChildByLocalName(dPr, "endChr") : null;
  const sepChrEl = dPr ? findChildByLocalName(dPr, "sepChr") : null;
  const begChr = begChrEl ? (getAttrValue(begChrEl, "val") ?? "(") : "(";
  const endChr = endChrEl ? (getAttrValue(endChrEl, "val") ?? ")") : ")";
  const sepChr = sepChrEl ? (getAttrValue(sepChrEl, "val") ?? "|") : "|";

  const children = (el.elements ?? []).filter(
    (c) => c.type === "element" && getLocalName(c.name ?? "") === "e",
  );
  const parts = children.map((c) => wrapMrow(renderChildren(c)));
  const inner = parts.join(`<mo>${escapeXml(sepChr)}</mo>`);

  return `<mrow><mo>${escapeXml(begChr)}</mo>${inner}<mo>${escapeXml(endChr)}</mo></mrow>`;
}

function renderMatrix(el: XmlElement): string {
  const rows = (el.elements ?? []).filter(
    (c) => c.type === "element" && getLocalName(c.name ?? "") === "mr",
  );
  const body = rows.map(renderMatrixRow).join("");
  return `<mtable>${body}</mtable>`;
}

function renderMatrixRow(row: XmlElement): string {
  const cells = (row.elements ?? []).filter(
    (c) => c.type === "element" && getLocalName(c.name ?? "") === "e",
  );
  const body = cells.map((c) => `<mtd>${renderChildren(c)}</mtd>`).join("");
  return `<mtr>${body}</mtr>`;
}

function renderAccent(el: XmlElement): string {
  const accPr = findChildByLocalName(el, "accPr");
  const chrEl = accPr ? findChildByLocalName(accPr, "chr") : null;
  const chr = chrEl ? (getAttrValue(chrEl, "val") ?? "̂") : "̂";
  const base = findChildByLocalName(el, "e");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  return `<mover accent="true">${baseMml}<mo>${escapeXml(chr)}</mo></mover>`;
}

function renderBar(el: XmlElement): string {
  const barPr = findChildByLocalName(el, "barPr");
  const posEl = barPr ? findChildByLocalName(barPr, "pos") : null;
  const pos = posEl ? (getAttrValue(posEl, "val") ?? "top") : "top";
  const base = findChildByLocalName(el, "e");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  const bar = '<mo stretchy="true">¯</mo>';
  return pos === "bot"
    ? `<munder>${baseMml}${bar}</munder>`
    : `<mover>${baseMml}${bar}</mover>`;
}

function renderGroupChr(el: XmlElement): string {
  const groupChrPr = findChildByLocalName(el, "groupChrPr");
  const posEl = groupChrPr ? findChildByLocalName(groupChrPr, "pos") : null;
  const pos = posEl ? (getAttrValue(posEl, "val") ?? "bot") : "bot";
  const chrEl = groupChrPr ? findChildByLocalName(groupChrPr, "chr") : null;
  const defaultChr = pos === "top" ? "⏞" : "⏟";
  const chr = chrEl ? (getAttrValue(chrEl, "val") ?? defaultChr) : defaultChr;
  const base = findChildByLocalName(el, "e");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  const grouper = `<mo stretchy="true">${escapeXml(chr)}</mo>`;
  return pos === "top"
    ? `<mover>${baseMml}${grouper}</mover>`
    : `<munder>${baseMml}${grouper}</munder>`;
}

function renderLimLow(el: XmlElement): string {
  const base = findChildByLocalName(el, "e");
  const lim = findChildByLocalName(el, "lim");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  const limMml = lim ? wrapMrow(renderChildren(lim)) : "<mrow/>";
  return `<munder>${baseMml}${limMml}</munder>`;
}

function renderLimUpp(el: XmlElement): string {
  const base = findChildByLocalName(el, "e");
  const lim = findChildByLocalName(el, "lim");
  const baseMml = base ? wrapMrow(renderChildren(base)) : "<mrow/>";
  const limMml = lim ? wrapMrow(renderChildren(lim)) : "<mrow/>";
  return `<mover>${baseMml}${limMml}</mover>`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function wrapMrow(body: string): string {
  if (!body) {
    return "<mrow/>";
  }
  return `<mrow>${body}</mrow>`;
}

function extractText(el: XmlElement): string {
  if (el.type === "text") {
    return textValue(el);
  }
  if (!el.elements) {
    return "";
  }
  let out = "";
  for (const child of el.elements) {
    if (child.type === "text") {
      out += textValue(child);
    } else {
      out += extractText(child);
    }
  }
  return out;
}

function textValue(el: XmlElement): string {
  const v = el.text;
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return "";
}

function getAttrValue(el: XmlElement, localAttr: string): string | undefined {
  if (!el.attributes) {
    return undefined;
  }
  for (const [k, v] of Object.entries(el.attributes)) {
    if (k === localAttr || k.endsWith(`:${localAttr}`)) {
      if (typeof v === "string") {
        return v;
      }
      if (v === undefined) {
        return undefined;
      }
      return String(v);
    }
  }
  return undefined;
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
