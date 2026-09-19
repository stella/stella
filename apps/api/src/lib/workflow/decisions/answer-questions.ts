/**
 * Table answers as System One questions.
 *
 * A question column (case-law results) and an AI property (matter table) both
 * ask one question per row and expect a value of the column's kind. For the
 * kinds whose answer space is closed, that is a selection, not a generation:
 * a select picks among its options, a date picks among the dates the text
 * contains, an integer among the numbers. This module turns such a column
 * into typed questions over the row's sources and reads the answers back as
 * the same `Answer` the generative path returns, so the two paths write the
 * same cell.
 *
 * Text columns have no closed answer space and are not planned here; the
 * caller keeps them on the generative model. Candidates for dates and
 * numbers are found in code (regex plus the agent-input readers), because a
 * System One model reads and judges but does not transcribe: it cannot
 * choose a value that is not on the list, which is also what makes a chosen
 * value verbatim.
 */

import { panic } from "better-result";

import { normalizeDateValue, normalizeNumber } from "@stll/agent-input";

import type { AiExtractablePropertyContent } from "@/api/db/schema-validators";
import type { Answer } from "@/api/lib/workflow/ai-answer-schema";
import type {
  Decisions,
  DecisionUndecidedReason,
} from "@/api/lib/workflow/decisions/decide";
import {
  choice,
  DEFAULT_SYSTEM_ONE_MODEL,
  noul,
  serializeSystemOneRequest,
  SYSTEM_ONE_MAX_CHOICE_OPTIONS,
  SYSTEM_ONE_MAX_QUESTIONS,
  SYSTEM_ONE_MAX_REQUEST_BYTES,
} from "@/api/lib/workflow/decisions/system-one";
import type {
  ChoiceAnswer,
  NoulAnswer,
  SystemOneEntry,
  SystemOneQuestion,
  SystemOneState,
} from "@/api/lib/workflow/decisions/system-one";

/**
 * Sources per request. Jev reads at most 32k tokens of state with the longest
 * question; Czech and Slovak legal prose runs under three characters a token,
 * so this holds with room for the questions.
 */
export const SYSTEM_ONE_SOURCE_BUDGET_CHARS = 40_000;
/** One slot is reserved for the planner's `__not_stated` option. */
export const SYSTEM_ONE_SINGLE_SELECT_MAX_OPTIONS =
  SYSTEM_ONE_MAX_CHOICE_OPTIONS - 1;
/** Bound fan-out even when one property expands into many Noul questions. */
export const SYSTEM_ONE_ANSWER_PLAN_MAX_QUESTIONS = SYSTEM_ONE_MAX_QUESTIONS;
/** Keep the planned wire request within the transport's UTF-8 byte ceiling. */
export const SYSTEM_ONE_ANSWER_PLAN_MAX_REQUEST_BYTES =
  SYSTEM_ONE_MAX_REQUEST_BYTES;

/** A Noul this far from 0.5 counts as a yes. */
const NOUL_YES = 0.5;
/** A where-question is asked only over a list a reader could scan. */
const LOCATOR_CHOICE_MAX_SOURCES = 40;
const LOCATOR_DESCRIPTION_CHARS = 160;
/** Candidate dates or numbers offered per question. */
const CANDIDATES_MAX = 60;
const CANDIDATE_SNIPPET_CHARS = 60;
const RUNNER_UP_MIN_PROBABILITY = 0.02;

const NOT_STATED = "__not_stated";
const NO_SOURCE = "__none";

export type AnswerSource = {
  /** The id the caller cites: a passage anchor, a folio block id, a bates page. */
  id: string;
  text: string;
};

export type SystemOneAnswerableContent = Exclude<
  AiExtractablePropertyContent,
  { type: "text" }
>;

export const isSystemOneAnswerable = (
  content: AiExtractablePropertyContent,
): content is SystemOneAnswerableContent => content.type !== "text";

export type AnswerQuestion = {
  id: string;
  question: string;
  content: SystemOneAnswerableContent;
};

export type AnswerOutcome =
  | {
      state: "answered";
      answer: Exclude<Answer, null>;
      /** Probability of the chosen value; the yes-probability floor for a multi-select. */
      probability: number;
      confidence: number;
      /** The source the model placed the answer in, when it named one. */
      sourceId: string | null;
      rationale: string;
    }
  | {
      /** The model chose "not stated": the sources do not settle the question. */
      state: "not_stated";
      confidence: number;
      rationale: string;
    }
  | {
      /** No answer to write: no decision model, under the floor, or a failed call. */
      state: "undecided";
      reason: DecisionUndecidedReason;
    };

type Candidate = {
  key: string;
  verbatim: string;
  sourceId: string;
  snippet: string;
  value: Exclude<Answer, null | string[]>;
};

type Plan =
  | { kind: "single-select"; valueKey: string; whereKey: string | null }
  | { kind: "multi-select"; optionKeys: string[]; whereKey: string | null }
  | { kind: "candidates"; valueKey: string | null; candidates: Candidate[] };

type PlannedQuestion = {
  plan: Plan;
  questions: Record<string, SystemOneQuestion>;
};

export type SystemOneAnswerPlan = {
  state: SystemOneState;
  questions: Record<string, SystemOneQuestion>;
  /** Questions the plan could not ask: a select with no options, a date with no candidate. */
  unplanned: string[];
  plans: Map<string, Plan>;
};

/** What `decideMany` returns for a plan's questions, keyed the same way. */
type PlanDecisions = Decisions<Record<string, SystemOneQuestion>>;

type SelectContent = Extract<
  SystemOneAnswerableContent,
  { type: "single-select" | "multi-select" }
>;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/gu, " ").trim();

const snippetAround = (text: string, at: number, length: number): string => {
  const start = Math.max(0, at - CANDIDATE_SNIPPET_CHARS);
  const end = Math.min(text.length, at + length + CANDIDATE_SNIPPET_CHARS);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${head}${collapseWhitespace(text.slice(start, end))}${tail}`;
};

/** Spellings a decision or a contract writes a calendar date in. */
const DATE_PATTERNS = [
  /\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\b/gu,
  /\b\d{4}-\d{2}-\d{2}\b/gu,
  /\b\d{1,2}\.?\s+\p{L}{3,}\s+\d{4}\b/gu,
  /\b\p{L}{3,}\.?\s+\d{1,2},?\s+\d{4}\b/gu,
];

/** Digit groups with the separators Stella's locales emit; decimals are read, not kept. */
const NUMBER_PATTERN =
  /(?<![\d.,])(?:\d{1,3}(?:[   .,']\d{3})+|\d+)(?:[.,]\d{1,2})?(?![\d])/gu;
/** A currency the number carries as an affix: an ISO code or a symbol beside it. */
const CURRENCY_BEFORE = /(?:([A-Z]{3})|([€$£]|Kč|zł|Ft|kr|lei))\s*$/u;
const CURRENCY_AFTER = /^\s*(?:([A-Z]{3})|([€$£]|Kč|zł|Ft|kr|lei))(?![\p{L}])/u;
const CURRENCY_BY_SYMBOL: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  Kč: "CZK",
  zł: "PLN",
  Ft: "HUF",
  kr: "SEK",
  lei: "RON",
};

type CurrencyAffix = { code: string; verbatim: string };

/** The currency written beside a number, and the number with it as written. */
const currencyBeside = (
  text: string,
  start: number,
  end: number,
): CurrencyAffix | null => {
  const before = CURRENCY_BEFORE.exec(
    text.slice(Math.max(0, start - 6), start),
  );
  const after = CURRENCY_AFTER.exec(text.slice(end, end + 6));
  const hit = before ?? after;
  if (hit === null) {
    return null;
  }
  const [, code, symbol] = hit;
  const resolved =
    code ??
    (symbol === undefined ? null : (CURRENCY_BY_SYMBOL[symbol] ?? null));
  if (resolved === null) {
    return null;
  }
  const number = text.slice(start, end);
  return {
    code: resolved,
    verbatim:
      before === null
        ? `${number}${text.slice(end, end + hit[0].length)}`
        : `${text.slice(start - hit[0].length, start)}${number}`,
  };
};

/** Where the dates sit, so their day, month and year are not offered as numbers. */
const dateSpans = (text: string): [number, number][] =>
  DATE_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match): [number, number] => [
      match.index,
      match.index + match[0].length,
    ]),
  );

type CandidateOptions = {
  sources: readonly AnswerSource[];
  /** The text's language, for month names and decimal conventions. */
  language: string;
};

const dateCandidates = ({
  sources,
  language,
}: CandidateOptions): Candidate[] => {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const pattern of DATE_PATTERNS) {
      for (const match of source.text.matchAll(pattern)) {
        const verbatim = match[0];
        const read = normalizeDateValue(verbatim, { locales: [language] });
        if (!read.ok) {
          continue;
        }
        const dedupe = `${read.value}|${source.id}`;
        if (seen.has(dedupe)) {
          continue;
        }
        seen.add(dedupe);
        candidates.push({
          key: `c${String(candidates.length + 1)}`,
          verbatim,
          sourceId: source.id,
          snippet: snippetAround(source.text, match.index, verbatim.length),
          value: read.value,
        });
        if (candidates.length >= CANDIDATES_MAX) {
          return candidates;
        }
      }
    }
  }
  return candidates;
};

const integerCandidates = ({
  sources,
  language,
}: CandidateOptions): Candidate[] => {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const inDate = dateSpans(source.text);
    for (const match of source.text.matchAll(NUMBER_PATTERN)) {
      const number = match[0];
      const end = match.index + number.length;
      if (inDate.some(([from, to]) => match.index >= from && end <= to)) {
        continue;
      }
      const read = normalizeNumber(number, { locale: language });
      if (!read.ok || !Number.isSafeInteger(read.value)) {
        continue;
      }
      const affix = currencyBeside(source.text, match.index, end);
      const currency = affix?.code ?? null;
      const dedupe = `${String(read.value)}|${currency ?? ""}|${source.id}`;
      if (seen.has(dedupe)) {
        continue;
      }
      seen.add(dedupe);
      candidates.push({
        key: `c${String(candidates.length + 1)}`,
        verbatim: affix?.verbatim ?? number,
        sourceId: source.id,
        snippet: snippetAround(source.text, match.index, number.length),
        value: { amount: read.value, currency },
      });
      if (candidates.length >= CANDIDATES_MAX) {
        return candidates;
      }
    }
  }
  return candidates;
};

const candidateCriteria = (
  candidates: readonly Candidate[],
): Record<string, SystemOneEntry> => {
  const criteria: Record<string, SystemOneEntry> = {};
  for (const candidate of candidates) {
    criteria[candidate.key] = {
      value: candidate.verbatim,
      in: candidate.sourceId,
      context: candidate.snippet,
    };
  }
  criteria[NOT_STATED] =
    "None of the listed values is the one the question asks for, or the sources do not state it.";
  return criteria;
};

const whereQuestion = (
  question: string,
  sources: readonly AnswerSource[],
): SystemOneQuestion | null => {
  if (sources.length === 0 || sources.length > LOCATOR_CHOICE_MAX_SOURCES) {
    return null;
  }
  const criteria: Record<string, SystemOneEntry> = {};
  for (const source of sources) {
    criteria[source.id] = truncate(
      collapseWhitespace(source.text),
      LOCATOR_DESCRIPTION_CHARS,
    );
  }
  criteria[NO_SOURCE] = "No source states the answer.";
  return choice(
    {
      question,
      task: "Which entry of `sources` states the answer to `question`? Choose `__none` when no entry states it.",
    },
    criteria,
  );
};

const selectOptionKey = (index: number): string => `o${String(index + 1)}`;

const planSelect = (
  question: AnswerQuestion,
  content: SelectContent,
  sources: readonly AnswerSource[],
): PlannedQuestion | null => {
  if (
    content.options.length === 0 ||
    (content.type === "single-select" &&
      content.options.length > SYSTEM_ONE_SINGLE_SELECT_MAX_OPTIONS)
  ) {
    return null;
  }
  const questions: Record<string, SystemOneQuestion> = {};
  const where = whereQuestion(question.question, sources);
  const whereKey = where === null ? null : `${question.id}:where`;
  if (where !== null && whereKey !== null) {
    questions[whereKey] = where;
  }
  if (content.type === "single-select") {
    const criteria: Record<string, SystemOneEntry> = {};
    for (const [index, option] of content.options.entries()) {
      criteria[selectOptionKey(index)] = option.value;
    }
    criteria[NOT_STATED] =
      "The sources do not state this, or none of the listed options applies.";
    const valueKey = `${question.id}:value`;
    questions[valueKey] = choice(
      {
        question: question.question,
        task: "Which option answers `question` according to `sources`? Judge only what the sources state; do not use outside knowledge.",
      },
      criteria,
    );
    return {
      plan: { kind: "single-select", valueKey, whereKey },
      questions,
    };
  }
  const optionKeys = content.options.map((option, index) => {
    const key = `${question.id}:${selectOptionKey(index)}`;
    questions[key] = noul(
      {
        question: question.question,
        option: option.value,
        task: "According to `sources`, is `option` one of the answers to `question`?",
      },
      {
        true: "The sources state that this option applies.",
        false:
          "The sources do not state it, or they state that it does not apply.",
      },
    );
    return key;
  });
  return {
    plan: { kind: "multi-select", optionKeys, whereKey },
    questions,
  };
};

const planCandidates = (
  question: AnswerQuestion,
  candidates: Candidate[],
  noun: string,
): PlannedQuestion | null => {
  if (candidates.length === 0) {
    return null;
  }
  const questions: Record<string, SystemOneQuestion> = {};
  const valueKey = `${question.id}:value`;
  questions[valueKey] = choice(
    {
      question: question.question,
      task: `Which of the listed ${noun} is the one \`question\` asks for? Each option shows the value as written, the source it appears in, and its surrounding text. Choose \`__not_stated\` when none of them is.`,
    },
    candidateCriteria(candidates),
  );
  return {
    plan: { kind: "candidates", valueKey, candidates },
    questions,
  };
};

const requestBytes = (
  state: SystemOneState,
  questions: Record<string, SystemOneQuestion>,
): number =>
  new TextEncoder().encode(
    serializeSystemOneRequest({
      state,
      model: DEFAULT_SYSTEM_ONE_MODEL,
      questions,
    }),
  ).byteLength;

export type PlanSystemOneAnswersOptions = {
  /** Named facts about the row the sources belong to: case number, court, file name. */
  document: Record<string, string>;
  sources: readonly AnswerSource[];
  /** The sources' language, for month names and decimal conventions. */
  language: string;
  questions: readonly AnswerQuestion[];
};

/**
 * One request's worth of questions over one row's sources. Questions that
 * cannot be asked (no options, no candidate in the text) are listed in
 * `unplanned`; the caller decides whether that means "not stated" or a
 * generative fallback.
 */
export const planSystemOneAnswers = ({
  document,
  sources,
  language,
  questions: asked,
}: PlanSystemOneAnswersOptions): SystemOneAnswerPlan => {
  const state = {
    document,
    sources: sources.map((source) => ({ id: source.id, text: source.text })),
  };
  const questions: Record<string, SystemOneQuestion> = {};
  const plans = new Map<string, Plan>();
  const unplanned: string[] = [];
  let dates: Candidate[] | undefined;
  let integers: Candidate[] | undefined;
  for (const question of asked) {
    const { content } = question;
    let staged: PlannedQuestion | null;
    switch (content.type) {
      case "single-select":
      case "multi-select":
        staged = planSelect(question, content, sources);
        break;
      case "date":
        dates ??= dateCandidates({ sources, language });
        staged = planCandidates(question, dates, "dates");
        break;
      case "int":
        integers ??= integerCandidates({ sources, language });
        staged = planCandidates(question, integers, "numbers");
        break;
      default: {
        content satisfies never;
        panic("Unhandled answer content kind");
      }
    }
    if (staged === null) {
      unplanned.push(question.id);
      continue;
    }
    const stagedEntries = Object.entries(staged.questions);
    const hasKeyCollision = stagedEntries.some(([key]) =>
      Object.hasOwn(questions, key),
    );
    const nextQuestions: Record<string, SystemOneQuestion> = {};
    for (const [key, plannedQuestion] of Object.entries(questions)) {
      nextQuestions[key] = plannedQuestion;
    }
    for (const [key, plannedQuestion] of stagedEntries) {
      nextQuestions[key] = plannedQuestion;
    }
    if (
      hasKeyCollision ||
      Object.keys(nextQuestions).length >
        SYSTEM_ONE_ANSWER_PLAN_MAX_QUESTIONS ||
      requestBytes(state, nextQuestions) >
        SYSTEM_ONE_ANSWER_PLAN_MAX_REQUEST_BYTES
    ) {
      unplanned.push(question.id);
      continue;
    }
    for (const [key, plannedQuestion] of stagedEntries) {
      questions[key] = plannedQuestion;
    }
    plans.set(question.id, staged.plan);
  }
  return {
    state,
    questions,
    unplanned,
    plans,
  };
};

const percent = (probability: number): string =>
  `${String(Math.round(probability * 100))}%`;

const runnerUp = (
  answer: ChoiceAnswer,
  label: (key: string) => string,
): string => {
  const next = Object.entries(answer.probabilities)
    .filter(([key]) => key !== answer.choice)
    .sort(([, a], [, b]) => b - a)
    .at(0);
  if (next === undefined || next[1] < RUNNER_UP_MIN_PROBABILITY) {
    return "";
  }
  return `; next ${label(next[0])} at ${percent(next[1])}`;
};

/**
 * The source the model placed the answer in. The where-question is auxiliary:
 * undecided it only costs the answer its citation, never the answer.
 */
const sourceChosen = (
  decisions: PlanDecisions,
  whereKey: string | null,
): string | null => {
  if (whereKey === null) {
    return null;
  }
  const where = decisions[whereKey];
  if (where === undefined || where.state === "undecided") {
    return null;
  }
  const { answer } = where;
  if (answer.type !== "choice" || answer.choice === NO_SOURCE) {
    return null;
  }
  return answer.choice;
};

const notStated = (confidence: number): AnswerOutcome => ({
  state: "not_stated",
  confidence,
  rationale: `Jev found no answer in the text (${percent(confidence)} confidence).`,
});

const decodeSingleSelect = (
  answer: ChoiceAnswer,
  content: SelectContent,
  sourceId: string | null,
): AnswerOutcome => {
  const label = (key: string): string => {
    if (key === NOT_STATED) {
      return "not stated";
    }
    const index = Number(key.slice(1)) - 1;
    return `"${content.options[index]?.value ?? key}"`;
  };
  if (answer.choice === NOT_STATED) {
    return notStated(answer.confidence);
  }
  const index = Number(answer.choice.slice(1)) - 1;
  const option = content.options[index];
  if (option === undefined) {
    return notStated(answer.confidence);
  }
  const probability = answer.probabilities[answer.choice] ?? 0;
  return {
    state: "answered",
    answer: option.value,
    probability,
    confidence: answer.confidence,
    sourceId,
    rationale: `Jev chose ${label(answer.choice)} at ${percent(probability)}${runnerUp(answer, label)}.`,
  };
};

/**
 * Every option is its own decision, so one option under the floor leaves the
 * whole cell undecided: a list the model was unsure about anywhere is not a
 * list, and the generative model answers the column instead.
 */
const decodeMultiSelect = (
  optionAnswers: readonly (readonly [string, NoulAnswer])[],
  sourceId: string | null,
): AnswerOutcome => {
  const chosen = optionAnswers.filter(([, answer]) => answer.noul > NOUL_YES);
  const confidence =
    optionAnswers.length === 0
      ? 0
      : optionAnswers.reduce(
          (sum, [, answer]) => sum + Math.abs(answer.noul * 2 - 1),
          0,
        ) / optionAnswers.length;
  if (chosen.length === 0) {
    return notStated(confidence);
  }
  const listed = chosen
    .map(([value, answer]) => `"${value}" (${percent(answer.noul)})`)
    .join(", ");
  return {
    state: "answered",
    answer: chosen.map(([value]) => value),
    probability: Math.min(...chosen.map(([, answer]) => answer.noul)),
    confidence,
    sourceId,
    rationale: `Jev marked ${listed}.`,
  };
};

const decodeCandidates = (
  answer: ChoiceAnswer,
  candidates: readonly Candidate[],
): AnswerOutcome => {
  const byKey = new Map(
    candidates.map((candidate) => [candidate.key, candidate]),
  );
  const label = (key: string): string => {
    const candidate = byKey.get(key);
    return candidate === undefined ? "not stated" : `"${candidate.verbatim}"`;
  };
  const candidate = byKey.get(answer.choice);
  if (candidate === undefined) {
    return notStated(answer.confidence);
  }
  const probability = answer.probabilities[answer.choice] ?? 0;
  const reading =
    typeof candidate.value === "string"
      ? candidate.value
      : `${String(candidate.value.amount)}${candidate.value.currency === null ? "" : ` ${candidate.value.currency}`}`;
  return {
    state: "answered",
    answer: candidate.value,
    probability,
    confidence: answer.confidence,
    sourceId: candidate.sourceId,
    rationale: `Jev chose "${candidate.verbatim}" (read as ${reading}) in ${candidate.sourceId} at ${percent(probability)}${runnerUp(answer, label)}.`,
  };
};

type DecodeSystemOneAnswersOptions = {
  plan: SystemOneAnswerPlan;
  questions: readonly AnswerQuestion[];
  /** `decideMany` over `plan.questions`: one decision per question asked. */
  decisions: PlanDecisions;
};

const undecided = (reason: DecisionUndecidedReason): AnswerOutcome => ({
  state: "undecided",
  reason,
});

/**
 * One outcome per planned question. A question the plan skipped has no entry;
 * the caller reads `plan.unplanned` for those.
 */
export const decodeSystemOneAnswers = ({
  plan,
  questions,
  decisions,
}: DecodeSystemOneAnswersOptions): Map<string, AnswerOutcome> => {
  const outcomes = new Map<string, AnswerOutcome>();
  for (const question of questions) {
    const entry = plan.plans.get(question.id);
    if (entry === undefined) {
      continue;
    }
    switch (entry.kind) {
      case "single-select": {
        const decision = decisions[entry.valueKey];
        if (
          decision === undefined ||
          question.content.type !== "single-select"
        ) {
          break;
        }
        if (decision.state === "undecided") {
          outcomes.set(question.id, undecided(decision.reason));
          break;
        }
        if (decision.answer.type !== "choice") {
          break;
        }
        outcomes.set(
          question.id,
          decodeSingleSelect(
            decision.answer,
            question.content,
            sourceChosen(decisions, entry.whereKey),
          ),
        );
        break;
      }
      case "multi-select": {
        if (question.content.type !== "multi-select") {
          break;
        }
        const { options } = question.content;
        const optionAnswers: (readonly [string, NoulAnswer])[] = [];
        let unsure: DecisionUndecidedReason | null = null;
        for (const [index, key] of entry.optionKeys.entries()) {
          const decision = decisions[key];
          const option = options[index];
          if (decision === undefined || option === undefined) {
            continue;
          }
          if (decision.state === "undecided") {
            unsure ??= decision.reason;
            continue;
          }
          if (decision.answer.type === "noul") {
            optionAnswers.push([option.value, decision.answer]);
          }
        }
        outcomes.set(
          question.id,
          unsure === null
            ? decodeMultiSelect(
                optionAnswers,
                sourceChosen(decisions, entry.whereKey),
              )
            : undecided(unsure),
        );
        break;
      }
      case "candidates": {
        if (entry.valueKey === null) {
          break;
        }
        const decision = decisions[entry.valueKey];
        if (decision === undefined) {
          break;
        }
        if (decision.state === "undecided") {
          outcomes.set(question.id, undecided(decision.reason));
          break;
        }
        if (decision.answer.type === "choice") {
          outcomes.set(
            question.id,
            decodeCandidates(decision.answer, entry.candidates),
          );
        }
        break;
      }
      default: {
        entry satisfies never;
        panic("Unhandled answer plan kind");
      }
    }
  }
  return outcomes;
};
