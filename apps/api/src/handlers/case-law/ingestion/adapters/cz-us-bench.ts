import { panic } from "better-result";

import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { stripAcademicTitles } from "@/api/handlers/case-law/judges/judge-name";
import type { CzechDeclinedDecisionJudge } from "@/api/lib/legal-search/ingestion-types";

/**
 * The bench a Czech Constitutional Court decision states in its opening
 * sentence.
 *
 * The record card names only the rapporteur and the judges who wrote
 * separately; who else sat is stated once, in the sentence that opens the
 * decision:
 *
 *   Ústavní soud rozhodl v senátě složeném z předsedy Jana Svatoně (soudce
 *   zpravodaje), soudce Milana Hulmáka a soudkyně Daniely Zemanové o ústavní
 *   stížnosti …
 *
 *   Ústavní soud rozhodl v plénu složeném z předsedy soudu Pavla Rychetského a
 *   soudců Ludvíka Davida, Jaroslava Fenyka (soudce zpravodaj), … o návrhu …
 *
 *   Ústavní soud rozhodl soudcem zpravodajem Michalem Bartoněm o ústavní
 *   stížnosti …
 *
 * The names stand in the case the sentence puts them in, so they are returned
 * as declined names for the roster to resolve, never as names to show.
 */

/** The opening sentence is the decision's first; nothing later is a bench. */
const OPENING_WINDOW_CHARS = 3000;

/** How far past "Ústavní soud … rozhodl" the bench may start. */
const BENCH_START_WINDOW_CHARS = 300;

/** A plenum of fifteen with titles fits well inside this. */
const BENCH_MAX_CHARS = 1500;

const OPENING_PATTERN = /Ústavní\s+soud\b[^.]{0,80}?\brozhodl\b/u;

/**
 * Where the list of names starts: after "složeném z" for a panel or the
 * plenum, or after the instrumental "soudcem zpravodajem" of a decision one
 * judge takes alone. The space after it is left to the text, so a bench that
 * names nobody ("soudcem zpravodajem o ústavní stížnosti") ends at once.
 */
const BENCH_START_PATTERN =
  /složen[éý]m?\s+z(?=\s)|(?<single>soud(?:cem|kyní)\s+zpravodaj(?:em|kou))(?=\s)/u;

/**
 * What follows the bench: the matter decided ("o ústavní stížnosti", "o
 * návrhu", "ve věci") or the operative "takto".
 */
const BENCH_END_PATTERN =
  /[\s,](?:o|ve\s+věci|v\s+(?:právní\s+)?věci|takto)(?=[\s,:])/u;

const RAPPORTEUR_WORD = /zpravodaj/u;
const NAME_WORD = /^\p{Lu}[\p{L}'’-]*$/u;
const LOWERCASE_START = /^\p{Ll}/u;
const WHITESPACE = /\s+/u;
const WHITESPACE_RUNS = /\s+/gu;

/** A name of one word is a stray token, not a judge. */
const MIN_NAME_WORDS = 2;

type BenchSeat = "presiding" | "member" | "alone";

type BenchEntry = {
  declinedName: string;
  seat: BenchSeat;
  rapporteur: boolean;
};

/** The seat a role phrase ("předsedy senátu", "soudců", …) names. */
const seatOf = (phrase: string): BenchSeat =>
  phrase.startsWith("předsed") ? "presiding" : "member";

const roles = ({
  seat,
  rapporteur,
}: BenchEntry): CzechDeclinedDecisionJudge["role"][] => {
  switch (seat) {
    case "presiding":
      return rapporteur
        ? [DECISION_JUDGE_ROLE.PRESIDING, DECISION_JUDGE_ROLE.RAPPORTEUR]
        : [DECISION_JUDGE_ROLE.PRESIDING];
    case "member":
      return [
        rapporteur
          ? DECISION_JUDGE_ROLE.RAPPORTEUR
          : DECISION_JUDGE_ROLE.PANEL_MEMBER,
      ];
    case "alone":
      return [DECISION_JUDGE_ROLE.RAPPORTEUR];
    default: {
      seat satisfies never;
      return panic(`Unhandled bench seat: ${String(seat)}`);
    }
  }
};

/** The text from the bench's first name to just before the matter decided. */
const benchText = (
  text: string,
): { names: string; alone: boolean } | undefined => {
  const lead = text
    .slice(0, OPENING_WINDOW_CHARS)
    .replace(WHITESPACE_RUNS, " ");
  const opening = OPENING_PATTERN.exec(lead);
  if (opening === null) {
    return undefined;
  }
  const afterOpening = lead.slice(
    opening.index + opening[0].length,
    opening.index + opening[0].length + BENCH_START_WINDOW_CHARS,
  );
  const start = BENCH_START_PATTERN.exec(afterOpening);
  if (start === null) {
    return undefined;
  }
  const rest = lead.slice(
    opening.index + opening[0].length + start.index + start[0].length,
  );
  const end = BENCH_END_PATTERN.exec(rest.slice(0, BENCH_MAX_CHARS));
  if (end === null) {
    return undefined;
  }
  return {
    names: rest.slice(0, end.index),
    alone: start.groups?.["single"] !== undefined,
  };
};

/**
 * The bench split where the sentence separates it: at commas and at the
 * conjunction "a". The text arrives with its whitespace collapsed to single
 * spaces, so plain string splits find every separator without a pattern
 * that backtracks.
 */
const benchSegments = (names: string): string[] =>
  names.split(",").flatMap((part) => part.split(" a "));

/**
 * A segment without its parenthesised notes, and the notes: "(soudce
 * zpravodaje)" marks the name it follows.
 */
const withoutNotes = (segment: string): { text: string; notes: string[] } => {
  const notes: string[] = [];
  let text = "";
  let rest = segment;
  for (;;) {
    const open = rest.indexOf("(");
    const close = open === -1 ? -1 : rest.indexOf(")", open);
    if (close === -1) {
      return { text: `${text}${rest}`, notes };
    }
    text = `${text}${rest.slice(0, open)} `;
    notes.push(rest.slice(open + 1, close));
    rest = rest.slice(close + 1);
  }
};

/**
 * What one segment states: a name (after any role phrase), a role phrase on
 * its own, or neither, which is what a title left behind a comma ("Ph.D.",
 * "S.J.D.") is.
 */
type BenchSegment =
  | { type: "name"; phrase: string; words: string[]; rapporteur: boolean }
  | { type: "phrase"; phrase: string }
  | { type: "not-a-name" };

const readSegment = (segment: string): BenchSegment => {
  const { text, notes } = withoutNotes(segment);
  const words = stripAcademicTitles(text)
    .split(WHITESPACE)
    .filter((word) => word.length > 0);
  const phraseLength = words.findIndex((word) => !LOWERCASE_START.test(word));
  const phrase = words
    .slice(0, phraseLength === -1 ? words.length : phraseLength)
    .join(" ");
  const nameWords = phraseLength === -1 ? [] : words.slice(phraseLength);
  if (nameWords.length === 0) {
    return phrase.length === 0
      ? { type: "not-a-name" }
      : { type: "phrase", phrase };
  }
  return nameWords.length >= MIN_NAME_WORDS &&
    nameWords.every((word) => NAME_WORD.test(word))
    ? {
        type: "name",
        phrase,
        words: nameWords,
        rapporteur: notes.some((note) => RAPPORTEUR_WORD.test(note)),
      }
    : { type: "not-a-name" };
};

const benchEntries = (names: string, alone: boolean): BenchEntry[] => {
  const entries: BenchEntry[] = [];
  let seat: BenchSeat | null = alone ? "alone" : null;

  for (const segment of benchSegments(names)) {
    const read = readSegment(segment);
    switch (read.type) {
      case "phrase": {
        // A role phrase alone: "soudkyň" before "a soudců …" names the seat
        // of what follows, and "soudce zpravodaje" set off by commas marks
        // the name before it.
        const previous = entries.at(-1);
        if (RAPPORTEUR_WORD.test(read.phrase) && previous !== undefined) {
          previous.rapporteur = true;
        } else if (!alone) {
          seat = seatOf(read.phrase);
        }
        break;
      }
      case "not-a-name":
        // States no judge, so there is nothing to keep.
        break;
      case "name": {
        if (!alone && read.phrase.length > 0) {
          seat = seatOf(read.phrase);
        }
        // A name with no seat before it follows the presiding judge without
        // a role phrase; the sentence does not say what it is.
        if (seat !== null) {
          entries.push({
            declinedName: read.words.join(" "),
            seat,
            rapporteur: read.rapporteur,
          });
        }
        // The presiding judge is named alone; the names after them are
        // members unless a phrase says otherwise.
        if (seat === "presiding") {
          seat = null;
        }
        break;
      }
      default: {
        read satisfies never;
        return panic(`Unhandled bench segment: ${String(read)}`);
      }
    }
  }
  return entries;
};

/**
 * The judges the opening sentence names, in the order it prints them. Empty
 * when the decision does not open with a bench, which a decision taken by a
 * rapporteur who is not named does.
 */
export const czUsOpeningBench = (
  text: string,
): CzechDeclinedDecisionJudge[] => {
  const bench = benchText(text);
  if (bench === undefined) {
    return [];
  }
  return benchEntries(bench.names, bench.alone).flatMap((entry) =>
    roles(entry).map((role) => ({
      role,
      czechDeclinedName: entry.declinedName,
    })),
  );
};
