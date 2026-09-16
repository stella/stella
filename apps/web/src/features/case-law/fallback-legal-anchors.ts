import { hasBlockInlines } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";
import { locateGazetteCitations } from "@stll/legal-atlas/provision-citation-grammars";
import type {
  LocatedGazetteCitation,
  LocatedProvisionCitation,
  SupportedProvisionCitationGrammar,
} from "@stll/legal-atlas/provision-citation-grammars";

import { inlinesToPlainText } from "@/components/legal-reader/document-ast-text";

const CJEU_CASE_NUMBER =
  /(?<![\p{L}\p{N}])(?<caseNumber>[CTF]\s{0,3}[-‑–—­]\s{0,3}\d{1,4}\/\d{2})(?!\d)/gu;

export type StatuteCitationAnchor = LocatedGazetteCitation & {
  blockId: string;
  id: string;
};

export type ExternalDecisionCitationAnchor = {
  blockId: string;
  end: number;
  href: string;
  id: string;
  start: number;
};

export type AbbreviatedProvisionCitation = LocatedProvisionCitation & {
  blockId: string;
  id: string;
  sentenceText: string;
  spanStart: number;
};

/**
 * Provision references whose work is named by an abbreviation of the citing
 * court's jurisdiction. The grammar is the authority; this locator only walks
 * the blocks.
 */
export const locateAbbreviatedProvisionCitations = (
  blocks: readonly Block[],
  grammar: SupportedProvisionCitationGrammar,
): AbbreviatedProvisionCitation[] => {
  const citations: AbbreviatedProvisionCitation[] = [];
  let documentOffset = 0;

  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      continue;
    }
    const text = inlinesToPlainText(block.inlines);

    for (const citation of grammar.locateAbbreviatedProvisions(text)) {
      citations.push({
        ...citation,
        blockId: block.id,
        id: `${block.id}:abbreviated-provision:${String(citation.start)}`,
        sentenceText: text,
        spanStart: documentOffset + citation.start,
      });
    }
    documentOffset += text.length + 1;
  }
  return citations;
};

const CJEU_DASH_CHARACTERS = "-‑–—­";

const normalizeCjeuCaseNumber = (value: string): string =>
  Array.from(value, (character) => {
    if (CJEU_DASH_CHARACTERS.includes(character)) {
      return "-";
    }
    return character.trim() === "" ? "" : character;
  }).join("");

/**
 * Works cited by gazette number, whether or not a provision precedes them.
 * The gazette names the work's jurisdiction, so every grammar reads them.
 */
export const locateStatuteCitations = (
  blocks: readonly Block[],
): StatuteCitationAnchor[] => {
  const anchors: StatuteCitationAnchor[] = [];
  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      continue;
    }
    const text = inlinesToPlainText(block.inlines);
    for (const citation of locateGazetteCitations(text)) {
      anchors.push({
        ...citation,
        blockId: block.id,
        id: `${block.id}:statute:${String(citation.start)}`,
      });
    }
  }
  return anchors;
};

/** CJEU numbers link to CURIA when no richer resolved corpus link overlaps. */
export const locateExternalCjeuCitations = (
  blocks: readonly Block[],
): ExternalDecisionCitationAnchor[] => {
  const anchors: ExternalDecisionCitationAnchor[] = [];
  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      continue;
    }
    const text = inlinesToPlainText(block.inlines);
    CJEU_CASE_NUMBER.lastIndex = 0;
    for (
      let match = CJEU_CASE_NUMBER.exec(text);
      match !== null;
      match = CJEU_CASE_NUMBER.exec(text)
    ) {
      const caseNumber = match.groups?.["caseNumber"];
      if (caseNumber === undefined) {
        continue;
      }
      const normalized = normalizeCjeuCaseNumber(caseNumber);
      anchors.push({
        blockId: block.id,
        end: match.index + match[0].length,
        href: `https://curia.europa.eu/juris/liste.jsf?num=${encodeURIComponent(normalized)}`,
        id: `${block.id}:cjeu:${String(match.index)}`,
        start: match.index,
      });
    }
  }
  return anchors;
};
