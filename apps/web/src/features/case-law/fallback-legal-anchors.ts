import { hasBlockInlines } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";

import { inlinesToPlainText } from "@/components/legal-reader/document-ast-text";

const CZECH_STATUTE_CITATION =
  /(?<![\p{L}\p{N}])(?:č\.\s*)?(?<number>\d{1,5})\/(?<year>\d{4})\s+Sb\.(?!\s*(?:m\.\s*s\.|NSS|rozh\.))/giu;
const CJEU_CASE_NUMBER =
  /(?<![\p{L}\p{N}])(?<caseNumber>[CTF]\s{0,3}[-‑–—­]\s{0,3}\d{1,4}\/\d{2})(?!\d)/gu;

export type CzechStatuteCitationAnchor = {
  blockId: string;
  eli: string;
  end: number;
  id: string;
  start: number;
};

export type ExternalDecisionCitationAnchor = {
  blockId: string;
  end: number;
  href: string;
  id: string;
  start: number;
};

const normalizeCjeuCaseNumber = (value: string): string =>
  value.replace(/\s*[-‑–—­]\s*/u, "-");

/** Bare Czech Collection citations, whether or not a provision precedes them. */
export const locateCzechStatuteCitations = (
  blocks: readonly Block[],
): CzechStatuteCitationAnchor[] => {
  const anchors: CzechStatuteCitationAnchor[] = [];
  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      continue;
    }
    const text = inlinesToPlainText(block.inlines);
    CZECH_STATUTE_CITATION.lastIndex = 0;
    for (
      let match = CZECH_STATUTE_CITATION.exec(text);
      match !== null;
      match = CZECH_STATUTE_CITATION.exec(text)
    ) {
      const number = match.groups?.["number"];
      const year = match.groups?.["year"];
      if (number === undefined || year === undefined) {
        continue;
      }
      const eli = `https://www.e-sbirka.cz/eli/cz/sb/${year}/${number}`;
      anchors.push({
        blockId: block.id,
        eli,
        end: match.index + match[0].length,
        id: `${block.id}:statute:${String(match.index)}`,
        start: match.index,
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
