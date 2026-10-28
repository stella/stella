import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

export const LINK_RECALL_KINDS = [
  "decision",
  "reviewed-decision",
  "procedural-history",
  "provision",
] as const;

export type LinkRecallKind = (typeof LINK_RECALL_KINDS)[number];

export type LinkRecallPassage = {
  anchor: string;
  text: string;
};

export type AuditReference = {
  kind: LinkRecallKind;
  key: string;
  anchor: string;
  start: number;
  end: number;
  text: string;
  context: string;
};

/** Independent, conservative audit grammar; not a production extraction profile. */
export type ReferenceAuditProfile = {
  country: string;
  decisionPatterns: readonly string[];
  reviewedCue: string;
  proceduralCue: string;
  /** Must capture section, act and year; sectionSuffix is an optional group. */
  provisionPattern: string;
};

const PREFIX = String.raw`(?:(?:[čc]\p{M}*\.?\s*j\.?|sp\.?\s*zn\.?)\s*)?`;
const SHEET = String.raw`(?:\s*[-–—−]\s*\d+)?`;
const BOUNDARY = String.raw`(?<![\p{L}\p{M}\d/])`;
const END = String.raw`(?![\p{L}\p{M}\d/])`;
const HORIZONTAL_SPACE = String.raw`[^\S\r\n\u2028\u2029]`;
const PROVISION_NUMBER_LIST = String.raw`\d+[a-z]?(?:${HORIZONTAL_SPACE}*(?:,|a[žz]\p{M}*|a|[-–—])${HORIZONTAL_SPACE}*\d+[a-z]?){0,6}`;
const PROVISION_SUBDIVISION = String.raw`(?:odst\.?${HORIZONTAL_SPACE}*${PROVISION_NUMBER_LIST}|bod(?:u)?${HORIZONTAL_SPACE}*${PROVISION_NUMBER_LIST}|p[íi]\p{M}*sm\.?${HORIZONTAL_SPACE}*[a-z]\)?)`;
const PROVISION_LOCAL_SCOPE = String.raw`(?:${HORIZONTAL_SPACE}+(?:a[žz]\p{M}*|[-–—])${HORIZONTAL_SPACE}*${PROVISION_NUMBER_LIST})?(?:${HORIZONTAL_SPACE}+${PROVISION_SUBDIVISION}){0,4}${HORIZONTAL_SPACE}*(?:,${HORIZONTAL_SPACE}*)?`;
const ACT_INTRODUCER = String.raw`(?:(?:z[áa]\p{M}*k(?:ona|\.)|vyhl[áa]\p{M}*[šs]\p{M}*ky|na[řr]\p{M}*[íi]\p{M}*zen[íi]\p{M}*${HORIZONTAL_SPACE}+vl[áa]\p{M}*dy)${HORIZONTAL_SPACE}*(?:[čc]\p{M}*\.?${HORIZONTAL_SPACE}*)?|[čc]\p{M}*\.?${HORIZONTAL_SPACE}*)`;

// These patterns are deliberately maintained separately from production grammars:
// copying their coverage would hide shared omissions from a recall audit.
export const CZ_REFERENCE_AUDIT_PROFILE = {
  country: "CZE",
  decisionPatterns: [
    String.raw`${BOUNDARY}ECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9](?:[A-Z0-9_.-]*[A-Z0-9])?${END}`,
    String.raw`${BOUNDARY}[CTF]\s*[-‐‑–—−]\s*\d+\s*/\s*\d{2,4}${END}`,
    String.raw`${BOUNDARY}${PREFIX}(?:[IVXLCDM]+|Pl)\.\s*[ÚU]\p{M}*S\s*\d+\s*/\s*\d{2,4}${SHEET}${END}`,
    String.raw`${BOUNDARY}${PREFIX}\d{1,3}\s*(?:A(?:fs|zs|ds|ps|rs|os|prk|prn|s|o|f)?|Cdo|Tdo|Tz|Cdon|Cz|Co|To|C|T|Nc|Ncu|Komp|Pst)\s*\d+\s*/\s*\d{2,4}${SHEET}${END}`,
    String.raw`${BOUNDARY}(?:[čc]\p{M}*\.?\s*j\.?|sp\.?\s*zn\.?)\s*\d{1,3}\s*[\p{L}\p{M}]{1,12}\s*\d+\s*/\s*\d{2,4}${SHEET}${END}`,
  ],
  reviewedCue: String.raw`(?:(?:kasa[čc]\p{M}*n[íi]\p{M}*|[úu]\p{M}*stavn[íi]\p{M}*)\s+st[íi]\p{M}*[žz]\p{M}*nosti|(?:dovol|odvol)[áa]\p{M}*n[íi]\p{M}*)[^;!?]{0,700}?proti\s+(?:rozsudku|usnesen[íi]\p{M}*)`,
  proceduralCue: String.raw`(?:v\s+p[řr]\p{M}*edchoz[íi]\p{M}*m\s+[řr]\p{M}*[íi]\p{M}*zen[íi]\p{M}*|p[řr]\p{M}*edchoz[íi]\p{M}*\s+(?:rozsudek|rozsudku|usnesen[íi]\p{M}*)|ji[žz]\p{M}*\s+d[řr]\p{M}*[íi]\p{M}*ve|zru[šs]\p{M}*(?:il|en))`,
  provisionPattern: String.raw`§\s*(?<section>[1-9]\d*)(?<sectionSuffix>[a-z]?)(?![\p{L}\p{M}\d])${PROVISION_LOCAL_SCOPE}${ACT_INTRODUCER}(?<act>[1-9]\d*)${HORIZONTAL_SPACE}*/${HORIZONTAL_SPACE}*(?<year>[1-9]\d{3})${HORIZONTAL_SPACE}*Sb\.(?![\p{L}\p{M}\d])`,
} as const satisfies ReferenceAuditProfile;

/**
 * Docket-level comparison: sheet numbers and court identity are not compared.
 * Equal audit keys do not establish that two references resolve to one decision.
 */
export const auditDecisionKey = (text: string): string => {
  const canonical = normalizeUnicode(text, "NFC")
    .trim()
    .replace(/^cz\s*[:/-]?\s*/iu, "")
    .replace(/^(?:č\.?\s*j\.?|c\.?\s*j\.?|sp\.?\s*zn\.?)\s*/iu, "")
    .replace(/[‐‑–—−]/gu, "-")
    .replace(/\s+/gu, "")
    .toUpperCase();
  if (canonical.startsWith("ECLI:")) {
    return canonical;
  }
  return canonical.replace(/(\/\d{2,4})-\d+$/u, "$1");
};

type ExtractAuditReferencesOptions = {
  passages: readonly LinkRecallPassage[];
  profile: ReferenceAuditProfile;
  selfIdentifiers: readonly string[];
};

type DecisionMatch = {
  start: number;
  end: number;
  text: string;
};

const decisionMatches = (
  text: string,
  patterns: readonly RegExp[],
): DecisionMatch[] => {
  const matches: DecisionMatch[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (value.length === 0) {
        continue;
      }
      matches.push({
        start: match.index,
        end: match.index + value.length,
        text: value,
      });
    }
  }
  matches.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const nonOverlapping: DecisionMatch[] = [];
  for (const match of matches) {
    const previous = nonOverlapping.at(-1);
    if (previous && match.start < previous.end) {
      continue;
    }
    nonOverlapping.push(match);
  }
  return nonOverlapping;
};

const CONTEXT_RADIUS = 240;
const REVIEWED_RADIUS = 1200;
const PROCEDURAL_RADIUS = 220;

export const extractAuditReferences = ({
  passages,
  profile,
  selfIdentifiers,
}: ExtractAuditReferencesOptions): AuditReference[] => {
  const patterns = profile.decisionPatterns.map(
    (pattern) => new RegExp(pattern, "giu"),
  );
  const reviewedCue = new RegExp(profile.reviewedCue, "iu");
  const proceduralCue = new RegExp(profile.proceduralCue, "iu");
  const provisionPattern = new RegExp(profile.provisionPattern, "giu");
  const self = new Set(selfIdentifiers.map((value) => auditDecisionKey(value)));
  const references: AuditReference[] = [];
  let precedingText = "";

  for (const { anchor, text } of passages) {
    const decisions = decisionMatches(text, patterns);
    let previousEnd = 0;
    for (const [index, match] of decisions.entries()) {
      const key = auditDecisionKey(match.text);
      const context = text.slice(
        Math.max(0, match.start - CONTEXT_RADIUS),
        Math.min(text.length, match.end + CONTEXT_RADIUS),
      );
      const reference = { ...match, anchor, key, context };
      // The preceding decision, including a self citation, ends the scope of a cue.
      const before = text.slice(previousEnd, match.start);
      const reviewedBefore =
        `${previousEnd === 0 ? precedingText : ""}\n${before}`.slice(
          -REVIEWED_RADIUS,
        );
      const localBefore =
        before
          .slice(-PROCEDURAL_RADIUS)
          .split(/[;!?\n]/u)
          .at(-1) ?? "";
      const nextStart = decisions.at(index + 1)?.start ?? text.length;
      const localAfter =
        text
          .slice(match.end, Math.min(nextStart, match.end + PROCEDURAL_RADIUS))
          .split(/[.;!?\n]/u)
          .at(0) ?? "";
      previousEnd = match.end;
      if (self.has(key)) {
        continue;
      }
      references.push({ ...reference, kind: "decision" });
      if (reviewedCue.test(reviewedBefore)) {
        references.push({ ...reference, kind: "reviewed-decision" });
      }
      if (proceduralCue.test(`${localBefore} ${localAfter}`)) {
        references.push({ ...reference, kind: "procedural-history" });
      }
    }

    for (const match of text.matchAll(provisionPattern)) {
      const section = match.groups?.["section"];
      const act = match.groups?.["act"];
      const year = match.groups?.["year"];
      if (!section || !act || !year) {
        panic(`Invalid ${profile.country} audit provision capture groups`);
      }
      references.push({
        kind: "provision",
        key: `${act}/${year}:${section.toLowerCase()}${match.groups?.["sectionSuffix"]?.toLowerCase() ?? ""}`,
        anchor,
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        context: text.slice(
          Math.max(0, match.index - CONTEXT_RADIUS),
          Math.min(text.length, match.index + match[0].length + CONTEXT_RADIUS),
        ),
      });
    }
    // Only text following the last citation can introduce the next block's target.
    precedingText = `${precedingText}\n${text}`.slice(-REVIEWED_RADIUS);
    const lastDecision = decisions.at(-1);
    if (lastDecision) {
      precedingText = text.slice(lastDecision.end).slice(-REVIEWED_RADIUS);
    }
  }
  return references;
};
