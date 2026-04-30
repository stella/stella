/**
 * Phase 1 mock generator for the AI suggestion review queue.
 *
 * The generator scans the document text for a small number of patterns
 * lawyers actually care about (defined-term casing, common typos,
 * passive-voice flags, suspect citation formats) and returns suggestions
 * as if they came from the model. It exists so the queue UI can be
 * exercised end-to-end before the real backend endpoint lands in
 * Phase 2.
 *
 * No network. No persistence. Stateless. Real generators in later
 * phases will replace this with a workspace-scoped API call.
 */

import { useCallback, useMemo } from "react";

import type { AICitation, AIGenerateInput, AISuggestion } from "@stll/folio";

import type { AIGenerateResponse } from "@/components/ai-suggestions/types";

type Rule = {
  pattern: RegExp;
  replacement: string;
  topic: string;
  severity: AISuggestion["severity"];
  rationale: string;
};

const RULES: Rule[] = [
  // Typos
  {
    pattern: /\bteh\b/g,
    replacement: "the",
    topic: "Spelling",
    severity: "typo",
    rationale: "Likely typo: “teh” → “the”.",
  },
  {
    pattern: /\brecieve\b/gi,
    replacement: "receive",
    topic: "Spelling",
    severity: "typo",
    rationale: "Likely typo: “recieve” → “receive”.",
  },
  {
    pattern: /\boccured\b/gi,
    replacement: "occurred",
    topic: "Spelling",
    severity: "typo",
    rationale: "Likely typo: “occured” → “occurred”.",
  },
  {
    pattern: /\bagreemnet\b/gi,
    replacement: "agreement",
    topic: "Spelling",
    severity: "typo",
    rationale: "Likely typo: “agreemnet” → “agreement”.",
  },
  {
    pattern: /\bjudgement\b/g,
    replacement: "judgment",
    topic: "Legal usage",
    severity: "typo",
    rationale:
      "U.S. and Bluebook style use “judgment”. “Judgement” appears in some Commonwealth practice; flag for the document’s jurisdiction.",
  },

  // Style
  {
    pattern: /\bin order to\b/gi,
    replacement: "to",
    topic: "Concision",
    severity: "style",
    rationale:
      "“In order to” is verbose. Plain “to” reads cleaner and matches modern drafting style.",
  },
  {
    pattern: /\bprior to\b/gi,
    replacement: "before",
    topic: "Plain language",
    severity: "style",
    rationale:
      "Prefer “before” over “prior to” unless the formality is load-bearing.",
  },
  {
    pattern: /\bin the event that\b/gi,
    replacement: "if",
    topic: "Plain language",
    severity: "style",
    rationale:
      "Drafting guides flag “in the event that” as a wordy stand-in for “if”.",
  },

  // Substantive
  {
    pattern: /\bshall\b/g,
    replacement: "will",
    topic: "Modal verbs",
    severity: "substantive",
    rationale:
      "Most modern drafting guides (Garner, Adams) recommend reserving “shall” for explicit obligations or replacing it with “must” / “will”. Confirm intent before applying.",
  },
];

const CONTEXT_WINDOW = 24;
const MAX_SUGGESTIONS = 25;

function makeId(seed: number): string {
  return `mock-${Date.now().toString(36)}-${seed.toString(36)}`;
}

/**
 * Filter the rule set down to whatever the prompt or preset implies.
 *
 * Phase 1 mock — once Phase 2 lands, the model interprets the prompt
 * directly. Until then, simple keyword routing is enough to make the
 * preset / free-form distinction meaningful in the UI.
 */
function selectRules(input: AIGenerateInput): Rule[] {
  if (input.presetId === "typos") {
    return RULES.filter((r) => r.severity === "typo");
  }
  if (input.presetId === "concision") {
    return RULES.filter((r) => r.severity === "style");
  }
  if (input.presetId === "shall") {
    return RULES.filter(
      (r) => r.severity === "substantive" || r.replacement === "before",
    );
  }
  if (input.presetId !== undefined) {
    // Other presets ("defined-terms", "general") apply the full set.
    return RULES;
  }

  const prompt = input.prompt.toLowerCase();
  if (prompt.length === 0) {
    return RULES;
  }
  const wantsTypos = /typo|spell/.test(prompt);
  const wantsStyle = /tighten|concis|verbose|plain/.test(prompt);
  const wantsSubstantive = /shall|must|obliga|modal/.test(prompt);
  if (!wantsTypos && !wantsStyle && !wantsSubstantive) {
    return RULES;
  }
  return RULES.filter(
    (r) =>
      (wantsTypos && r.severity === "typo") ||
      (wantsStyle && r.severity === "style") ||
      (wantsSubstantive && r.severity === "substantive"),
  );
}

/**
 * Run the selected rules against the document. The input.documentText
 * already contains \n at block boundaries, so regex scanning gives us
 * the indices we need; the host re-anchors via context strings before
 * applying.
 */
function generate(input: AIGenerateInput): AISuggestion[] {
  const text = input.documentText;
  const rules = selectRules(input);
  const out: AISuggestion[] = [];
  let seed = 0;
  const seen = new Set<string>();

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const dedupe = `${start}:${end}:${rule.replacement}`;
      if (seen.has(dedupe)) {
        if (!rule.pattern.global) {
          break;
        }
        continue;
      }
      seen.add(dedupe);

      const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
      const after = text.slice(
        end,
        Math.min(text.length, end + CONTEXT_WINDOW),
      );

      out.push({
        id: makeId(seed++),
        topic: rule.topic,
        severity: rule.severity,
        // The Folio host re-resolves the PM range from
        // contextBefore/originalText/contextAfter on insertion, so the
        // recorded range is approximate; the resolver finds the real
        // PM coordinates.
        range: { from: start, to: end },
        originalText: match[0],
        suggestedText: rule.replacement,
        contextBefore: before,
        contextAfter: after,
        rationale: rule.rationale,
        confidence: rule.severity === "substantive" ? 0.6 : 0.8,
        status: "pending",
      });

      if (out.length >= MAX_SUGGESTIONS) {
        return out;
      }
      if (!rule.pattern.global) {
        break;
      }
    }
  }

  return out;
}

/**
 * Compose a short markdown response that frames the suggestions for
 * the user. Routed by prompt/preset so the answer feels purposeful
 * rather than mechanical.
 */
function composeAnswer(
  input: AIGenerateInput,
  suggestions: AISuggestion[],
): string {
  const prompt = input.prompt.toLowerCase();
  const isSummary = /summar|overview|describe|recap/.test(prompt);
  const isQuestion = /\?|who|what|when|where|why|how/.test(input.prompt);

  if (suggestions.length === 0) {
    if (isSummary) {
      return [
        "I scanned the document text and didn't find anything I'd flag for an edit. A few notes:",
        "",
        "- No spelling slips, archaic modal verbs, or obvious wordy phrases.",
        "- This view is mock-only — once the real backend is wired in, this same answer slot will carry the model's actual response.",
      ].join("\n");
    }
    if (isQuestion) {
      return "I can't answer that one in mock mode — the real backend isn't wired in yet. Once it is, the same answer slot will carry the model's response.";
    }
    return "Nothing jumped out on a scan of the document.";
  }

  const breakdown = {
    typo: suggestions.filter((s) => s.severity === "typo").length,
    style: suggestions.filter((s) => s.severity === "style").length,
    substantive: suggestions.filter((s) => s.severity === "substantive").length,
  };
  const parts: string[] = [];
  if (breakdown.substantive > 0) {
    parts.push(`${breakdown.substantive} substantive`);
  }
  if (breakdown.style > 0) {
    parts.push(`${breakdown.style} style`);
  }
  if (breakdown.typo > 0) {
    parts.push(`${breakdown.typo} typo${breakdown.typo === 1 ? "" : "s"}`);
  }
  const summary = parts.join(", ");
  if (input.presetId === "typos") {
    return `Found ${breakdown.typo} likely typo${breakdown.typo === 1 ? "" : "s"}.`;
  }
  if (input.presetId === "shall") {
    return `Flagged ${suggestions.length} place${suggestions.length === 1 ? "" : "s"} where modern drafting style would replace “shall” or another archaism.`;
  }
  return `Found ${summary}. Each is shown below — accept or reject individually, or use the bulk actions.`;
}

const SUMMARY_RESPONSE = [
  "Quick read of the document:",
  "",
  "- Mostly contractual prose, no glaring drafting issues on a first pass.",
  "- A handful of rephrasings would tighten it up; flagged inline below where applicable.",
  "- The mock generator can only see plain text — once the real backend is wired, this slot carries the model's full answer (parties, defined terms, key dates, etc.).",
].join("\n");

/**
 * Build a small set of mock citations pointing into the document.
 * For the mock we just pick a few short distinctive substrings so the
 * highlight is visible; the real backend will return citations the
 * model actually grounded its answer in.
 */
function buildMockCitations(input: AIGenerateInput): AICitation[] {
  const text = input.documentText;
  if (text.length === 0) {
    return [];
  }
  const candidates = [
    "governing law",
    "Effective Date",
    "Confidential",
    "Party",
    "shall",
  ];
  const out: AICitation[] = [];
  let label = 1;
  for (const needle of candidates) {
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) {
      continue;
    }
    const from = idx;
    const to = idx + needle.length;
    const quoteStart = Math.max(0, from - 20);
    const quoteEnd = Math.min(text.length, to + 40);
    const quote = text.slice(quoteStart, quoteEnd).replace(/\s+/g, " ").trim();
    out.push({
      id: `cite-${label}-${from}`,
      label: String(label),
      quote,
      // Mock as folio-range; the host re-resolves via the live PM doc
      // so plain-text indices line up to PM positions automatically.
      // PDF viewers will receive pdf-bbox citations from the real
      // backend — see the wrapper for how those flow through.
      source: { kind: "folio-range", from, to },
    });
    label += 1;
    if (label > 3) {
      break;
    }
  }
  return out;
}

/**
 * Hook returning a stable generator that resolves after a short
 * artificial latency, so the bar's "Thinking…" state has time to
 * render.
 */
export function useAISuggestionGenerator() {
  return useCallback(
    async (input: AIGenerateInput): Promise<AIGenerateResponse> => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 450);
      });
      const prompt = input.prompt.toLowerCase();

      // ASK mode: text + citations only. No edits proposed.
      if (input.mode === "ask") {
        const citations = buildMockCitations(input);
        if (/summar|overview|describe|recap/.test(prompt)) {
          return { text: SUMMARY_RESPONSE, citations };
        }
        if (input.presetId === "governing-law") {
          return {
            text: "The document references governing law in §1; click the citation below to jump to the clause.",
            citations,
          };
        }
        return {
          text: composeAskAnswer(input, citations),
          citations,
        };
      }

      // EDIT mode: produce suggestions; citations attach where helpful.
      const suggestions = generate(input);
      const citations = buildMockCitations(input);
      if (
        suggestions.length === 0 &&
        /summar|overview|describe|recap/.test(prompt)
      ) {
        return { text: SUMMARY_RESPONSE, citations };
      }
      return {
        text: composeAnswer(input, suggestions),
        suggestions,
        citations,
      };
    },
    [],
  );
}

/**
 * Compose a brief Ask-mode answer. The mock can't actually answer
 * questions, so the body is short and honest about that — the real
 * backend will replace this with a model response.
 */
function composeAskAnswer(
  _input: AIGenerateInput,
  citations: AICitation[],
): string {
  const intro = "Mock mode — the real backend isn't wired yet.";
  if (citations.length === 0) {
    return `${intro} Once it is, this answer will draw from the file directly.`;
  }
  return `${intro} The real model will ground its answer in the file; the chips below are mock citation pointers to give you a feel for how source-of-answer hops work.`;
}

/**
 * Hook returning a memoised AI chat config for the file viewer.
 *
 * The author label is used when the user opts to apply suggestions as
 * Word tracked changes — that flags the change as authored by Stella
 * AI rather than by the lawyer.
 */
export function useAISuggestionsConfig() {
  const onGenerate = useAISuggestionGenerator();
  return useMemo(
    () => ({
      onGenerate,
      defaultMode: "ask" as const,
      defaultApplyMode: "direct" as const,
      applyAuthor: "Stella AI",
      inputPlaceholder: "Ask AI about this file…",
    }),
    [onGenerate],
  );
}
