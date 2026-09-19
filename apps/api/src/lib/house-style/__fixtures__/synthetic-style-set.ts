/**
 * A synthetic style set and a synthetic document to convert.
 *
 * Every house-style test runs against these: invented style ids, invented
 * names, invented text. Nothing from a real firm's template is in the
 * repository, and the fixtures still carry what the conversion has to cope
 * with — a numbered heading hierarchy driven by list levels, a numbered body
 * level that prints no number, a centred style, a table, and a table of
 * contents the catalogue must leave out.
 */

import JSZip from "jszip";

import type { StyleGuideDraft } from "@/api/lib/house-style/guide";

const W_ATTRIBUTE =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export const HOUSE_STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles ${W_ATTRIBUTE}>
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1Firm">
    <w:name w:val="Heading 1 Firm"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:spacing w:before="160" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:caps/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2Firm">
    <w:name w:val="Heading 2 Firm"/>
    <w:basedOn w:val="Heading1Firm"/>
    <w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>
    <w:rPr><w:b w:val="0"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Bodytext1Firm">
    <w:name w:val="Body text 1 Firm"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:numPr><w:numId w:val="2"/></w:numPr><w:spacing w:after="240"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="DefinitionFirm">
    <w:name w:val="Definition Firm"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="CentredFirm">
    <w:name w:val="Centred Firm"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="TOC1">
    <w:name w:val="toc 1"/>
    <w:basedOn w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="UnusedFirm">
    <w:name w:val="Unused Firm"/>
    <w:basedOn w:val="Normal"/>
  </w:style>
</w:styles>`;

export const HOUSE_NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering ${W_ATTRIBUTE}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pStyle w:val="Heading1Firm"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/><w:pStyle w:val="Heading2Firm"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="none"/><w:lvlText w:val="%1"/><w:pStyle w:val="Bodytext1Firm"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/><w:pStyle w:val="DefinitionFirm"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;

const paragraph = ({
  style,
  text,
  bold = false,
}: {
  style: string | null;
  text: string;
  bold?: boolean;
}): string =>
  `<w:p>${style === null ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

export const HOUSE_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${W_ATTRIBUTE}><w:body>
  ${paragraph({ style: "TOC1", text: "Contents" })}
  ${paragraph({ style: "Heading1Firm", text: "Definitions and interpretation" })}
  ${paragraph({ style: "Heading1Firm", text: "The facility" })}
  ${paragraph({ style: "Heading2Firm", text: "The lender shall make the facility available." })}
  ${paragraph({ style: "Bodytext1Firm", text: "Subject to the terms of this agreement." })}
  ${paragraph({ style: "DefinitionFirm", text: "Business Day means a day banks are open." })}
  ${paragraph({ style: "CentredFirm", text: "Schedule 1" })}
  ${paragraph({ style: null, text: "Signed for and on behalf of the parties." })}
  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`;

/**
 * The document a conversion is asked to restyle: plain Word styles, headings
 * marked by bold text alone, and numbers typed by hand.
 */
export const SOURCE_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${W_ATTRIBUTE}><w:body>
  ${paragraph({ style: null, text: "SHORT-FORM LOAN AGREEMENT", bold: true })}
  <w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>
  ${paragraph({ style: null, text: "1. Definitions", bold: true })}
  ${paragraph({ style: null, text: "Business Day means a day other than a Saturday." })}
  ${paragraph({ style: null, text: "2.1 The Lender shall advance the Loan." })}
  <w:p><w:pPr><w:jc w:val="center"/><w:ind w:left="720"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">Schedule 1</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc>${paragraph({ style: null, text: "Party" })}</w:tc><w:tc><w:p/></w:tc></w:tr>
  </w:tbl>
  <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body></w:document>`;

export const EMPTY_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${W_ATTRIBUTE}><w:body/></w:document>`;

/**
 * A style set whose two deepest styles switch numbering off with the reserved
 * `w:numId` 0, which `w:basedOn` would otherwise hand them from their parent.
 *
 * They differ in what the cancelled list was covering. `UnnumberedSubClause`
 * is left with nothing: no list, and no `w:outlineLvl` anywhere up its chain.
 * `UnnumberedAnnex` is left with the outline level its parent declared, which
 * the parent's own list level had been hiding.
 */
export const CANCELLED_NUMBERING_STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles ${W_ATTRIBUTE}>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ClauseFirm">
    <w:name w:val="Clause Firm"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="SubClauseFirm">
    <w:name w:val="Sub-clause Firm"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="UnnumberedSubClauseFirm">
    <w:name w:val="Unnumbered Sub-clause Firm"/>
    <w:basedOn w:val="SubClauseFirm"/>
    <w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NumberedAnnexFirm">
    <w:name w:val="Numbered Annex Firm"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="3"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="UnnumberedAnnexFirm">
    <w:name w:val="Unnumbered Annex Firm"/>
    <w:basedOn w:val="NumberedAnnexFirm"/>
    <w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>
  </w:style>
</w:styles>`;

/**
 * The prose is uniform on purpose: the rule tier reads the ids and the order
 * a guide lists them in, never the words, and this set exists to exercise it.
 */
const cancelledNumberingEntry = (id: string, name: string) => ({
  id,
  name,
  purpose: `${name}, in the set that cancels numbering.`,
  use_when: `The paragraph belongs to ${name}.`,
  do_not_use_when: "The paragraph belongs to another style of the set.",
  hierarchy: "One of five styles, two of them cancelling their parent's list.",
  looks_like: `As ${name} defines it.`,
});

/**
 * Guide order breaks a tie between two styles claiming one level, so the
 * style whose numbering is cancelled is listed first: while it still
 * inherited its parent's list it took that level from the parent.
 */
export const CANCELLED_NUMBERING_GUIDE_DRAFT: StyleGuideDraft = {
  styles: [
    cancelledNumberingEntry(
      "UnnumberedSubClauseFirm",
      "Unnumbered Sub-clause Firm",
    ),
    cancelledNumberingEntry("ClauseFirm", "Clause Firm"),
    cancelledNumberingEntry("SubClauseFirm", "Sub-clause Firm"),
    cancelledNumberingEntry("NumberedAnnexFirm", "Numbered Annex Firm"),
    cancelledNumberingEntry("UnnumberedAnnexFirm", "Unnumbered Annex Firm"),
  ],
};

export const chainStyleId = (index: number): string => `S${String(index)}`;

/**
 * A style set built from one `w:basedOn` chain: `S0` on Normal, every later
 * style on the one before it. Each entry is the `w:numId` that style declares:
 * `null` declares no `w:numPr` at all, and 0 is the reserved "no numbering"
 * that cancels what the chain hands down.
 */
export const chainStylesXml = (chain: readonly (number | null)[]): string => {
  const styles = chain.map((numId, index) => {
    const numbering =
      numId === null
        ? ""
        : `<w:pPr><w:numPr><w:numId w:val="${String(numId)}"/></w:numPr></w:pPr>`;
    const basedOn = index === 0 ? "Normal" : chainStyleId(index - 1);
    return `<w:style w:type="paragraph" w:styleId="${chainStyleId(index)}">
    <w:name w:val="Chain ${String(index)}"/>
    <w:basedOn w:val="${basedOn}"/>
    ${numbering}
  </w:style>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:styles ${W_ATTRIBUTE}>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  ${styles.join("\n  ")}
</w:styles>`;
};

export type SyntheticPackageParts = {
  documentXml?: string;
  /** Null writes no `word/styles.xml`, which Word also accepts. */
  stylesXml?: string | null;
  numberingXml?: string | null;
};

/** A DOCX carrying only the parts the conversion reads. */
export const syntheticDocx = async ({
  documentXml = HOUSE_DOCUMENT_XML,
  stylesXml = HOUSE_STYLES_XML,
  numberingXml = HOUSE_NUMBERING_XML,
}: SyntheticPackageParts = {}): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  if (stylesXml !== null) {
    zip.file("word/styles.xml", stylesXml);
  }
  if (numberingXml !== null) {
    zip.file("word/numbering.xml", numberingXml);
  }
  zip.file("docProps/core.xml", CORE_PROPERTIES_XML);
  zip.file("word/comments.xml", COMMENTS_XML);
  return await zip.generateAsync({ type: "arraybuffer" });
};

export const CORE_PROPERTIES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:creator>A Person</dc:creator><cp:lastModifiedBy>Another Person</cp:lastModifiedBy>
</cp:coreProperties>`;

export const COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:comments ${W_ATTRIBUTE}><w:comment w:id="1"><w:p><w:r><w:t>An internal note</w:t></w:r></w:p></w:comment></w:comments>`;

/** A guide over the synthetic catalogue, in the shape a caller authors. */
export const SYNTHETIC_GUIDE_DRAFT: StyleGuideDraft = {
  styles: [
    {
      id: "Heading1Firm",
      name: "Heading 1 Firm",
      purpose: "Top-level clause heading.",
      use_when: "A new numbered clause of the agreement begins.",
      do_not_use_when: "The line is a title or a schedule heading.",
      hierarchy: "Top of the clause hierarchy; parent of Heading 2 Firm.",
      looks_like: "Bold capitals, numbered 1., 2., 3.",
    },
    {
      id: "Heading2Firm",
      name: "Heading 2 Firm",
      purpose: "Second-level numbered clause.",
      use_when: "A sub-clause of a numbered clause.",
      do_not_use_when: "The paragraph is unnumbered prose.",
      hierarchy: "Child of Heading 1 Firm.",
      looks_like: "Numbered 1.1, 1.2.",
    },
    {
      id: "Bodytext1Firm",
      name: "Body text 1 Firm",
      purpose: "Ordinary prose inside a clause.",
      use_when: "Prose that carries no number of its own.",
      do_not_use_when: "The line heads a clause.",
      hierarchy: "Body level 1.",
      looks_like: "Unnumbered paragraph, flush left.",
    },
    {
      id: "DefinitionFirm",
      name: "Definition Firm",
      purpose: "A defined term and its definition.",
      use_when: "The paragraph defines a term.",
      do_not_use_when: "The paragraph is an operative clause.",
      hierarchy: "Inside the definitions clause.",
      looks_like: "Lettered (a), (b).",
    },
    {
      id: "CentredFirm",
      name: "Centred Firm",
      purpose: "A centred title or schedule heading.",
      use_when: "The line is the document title or a schedule heading.",
      do_not_use_when: "The line is a numbered clause.",
      hierarchy: "Outside the clause hierarchy.",
      looks_like: "Centred, larger type.",
    },
  ],
};
