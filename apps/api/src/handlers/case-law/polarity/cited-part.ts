import { escapeRegExp, normalizeUnicode } from "@stll/text-normalize";

import {
  CITED_PART,
  CITED_PARTS,
} from "@/api/lib/case-law/citation-vocabulary";
import type { CitedPart } from "@/api/lib/case-law/citation-vocabulary";

/** A name cannot cross punctuation, a reference number, or a clause connector. */
const NAME_WORD =
  "(?!(?:in|of|and|k|v|ve|vo|a)(?!\\p{L}))\\p{Lu}[\\p{L}\\p{M}'’\\-]*";
const JUDGE_NAME = `${NAME_WORD}(?:\\s+${NAME_WORD}){0,3}`;

const OPINION_KINDS = CITED_PARTS.filter(
  (part) => part !== CITED_PART.NOT_STATED,
);

type OpinionKind = Exclude<CitedPart, "not-stated">;
type OpinionRules = {
  cues: Record<OpinionKind, string>;
  /** Links from the opinion to its decision; no arbitrary intervening words. */
  link: string;
  judge: string;
  possessive: string | null;
};

/** Separate/odlišné/osobitné opinions do not establish dissent or concurrence. */
export const CITED_PART_RULES = {
  cs: {
    cues: {
      dissent:
        "(?:(?:disentn|nesouhlasn)\\p{L}*\\s+(?:stanovisk|názor)\\p{L}*|disent(?:u|em)?)",
      concurrence: "(?:konkurujíc|souhlasn)\\p{L}*\\s+stanovisk\\p{L}*",
      majority: "většinov\\p{L}*\\s+(?:stanovisk|názor)\\p{L}*",
    },
    link: "(?:(?:k|v|ve)\\s+(?:(?:nález|rozsud|rozhodnut|usnesen)\\p{L}*\\s+)?|(?:v|ve)\\s+věci\\s+)",
    judge: `(?:soudc|soudkyn)\\p{L}*\\s+${JUDGE_NAME}\\s+`,
    possessive: null,
  },
  sk: {
    cues: {
      dissent:
        "(?:(?:disentn|nesúhlasn)\\p{L}*\\s+(?:stanovisk|názor)\\p{L}*|disent(?:u|om)?)",
      concurrence: "súhlasn\\p{L}*\\s+stanovisk\\p{L}*",
      majority: "väčšinov\\p{L}*\\s+(?:stanovisk|názor)\\p{L}*",
    },
    link: "(?:(?:k|v|vo)\\s+(?:(?:nález|rozsud|rozhodnut|uznesen)\\p{L}*\\s+)?|(?:v|vo)\\s+veci\\s+)",
    judge: `(?:sudc|sudkyn)\\p{L}*\\s+${JUDGE_NAME}\\s+`,
    possessive: null,
  },
  en: {
    cues: {
      dissent: "(?:dissenting\\s+opinion|dissent)",
      concurrence: "(?:concurring\\s+opinion|concurrence)",
      majority: "majority\\s+opinion",
    },
    link: "(?:in|of)\\s+(?:(?:case|decision|judgment)\\s+)?",
    judge: `of\\s+(?:judge|justice)\\s+${JUDGE_NAME}\\s+`,
    possessive: "['’]s\\s+",
  },
} as const satisfies Record<string, OpinionRules>;

type CitedPartArgs = {
  contexts: readonly string[];
  /** The printed reference whose opinion is being classified. */
  citationText: string;
  language: string;
};

/** Only an explicit opinion linked to this exact reference owns its part. */
export const classifyCitedPart = ({
  contexts,
  citationText,
  language,
}: CitedPartArgs): CitedPart => {
  const rules = Object.entries(CITED_PART_RULES).find(
    ([key]) => key === language,
  )?.[1];
  if (rules === undefined || citationText.length === 0) {
    return CITED_PART.NOT_STATED;
  }
  const target = escapeRegExp(normalizeUnicode(citationText, "NFC")).replaceAll(
    /\s+/gu,
    "\\s+",
  );
  const reference = `(?<![\\p{L}\\p{N}])${target}(?![\\p{L}\\p{N}/])`;
  const parts = new Set<OpinionKind>();
  for (const part of OPINION_KINDS) {
    const cue = rules.cues[part];
    const opinion = `(?<!\\p{L})${cue}(?!\\p{L})`;
    // Each branch is a grammatical link, not a distance heuristic. In
    // particular, a second reference cannot fit between the cue and target.
    const bindings = [
      `${opinion}\\s+(?:${rules.judge})?${rules.link}${reference}`,
      `${reference}\\s*\\(\\s*${opinion}\\s*\\)`,
    ];
    if (rules.possessive !== null) {
      bindings.push(
        `${reference}${rules.possessive}${opinion}(?=\\s*(?:[.,;:!?)]|$))`,
      );
    }
    const bound = new RegExp(bindings.join("|"), "iu");
    if (
      !contexts.some((context) => bound.test(normalizeUnicode(context, "NFC")))
    ) {
      continue;
    }
    parts.add(part);
  }
  return parts.size === 1
    ? (parts.values().next().value ?? CITED_PART.NOT_STATED)
    : CITED_PART.NOT_STATED;
};
