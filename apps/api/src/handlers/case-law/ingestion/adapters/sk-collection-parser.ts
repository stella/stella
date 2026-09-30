import { panic } from "better-result";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";

import { courtAbbreviation } from "@/api/lib/case-law/court-abbreviations";
import {
  SK_COLLECTION_SERIES,
  type SkCollectionDecision,
  type SkCollectionDefect,
  type SkCollectionIssue,
  type SkCollectionJoinOutcome,
  type SkCollectionParseOutcome,
  type SkCollectionRecord,
} from "@/api/lib/legal-search/sk-collection-enrichment";

export type SkCollectionTextPage = { page: number; lines: readonly string[] };

type IssueLine = { page: number; text: string };

const NS_NUMBER = /^\s*(?:R\s+\d+\/\d{4}|\d+\.)\s*$/u;
const NSS_NUMBER = /^\s*\d+\/\d{4}\s+ZNSS(?:\s*\(VS\s+\d+\/\d{4}\))?\s*$/u;
const NS_ENTRY_TITLE = /^\s*(?:ROZHODNUTIE|STANOVISKO)\s*$/u;
const LEGAL_SENTENCE_TITLE = /^\s*Právna veta\s*$/u;
const TARGET_START = /^\s*[([]\s*(?:rozsudok|uznesenie|stanovisko)\b/iu;
const TARGET_DOCKET =
  /sp\.\s*zn\.\s*(\d+\s*[\p{L}]+[\s/]*\d+\s*\/\s*\d{2,4}(?:-\d+)?)/u;
const TARGET_COURT =
  /(?:rozsudok|uznesenie|stanovisko)\s+(.+?)\s+(?:z\s|sp\.\s*zn\.)/iu;
const ECLI = /ECLI:SK:[A-Z\d]+:\d{4}:[A-Z\d.]+/u;
const MIN_TEXT_CHARACTERS = 100;
const MAX_HEADNOTE_CHARACTERS = 20_000;

const nonemptyLine = (lines: readonly IssueLine[], start: number) => {
  for (let index = start; index < lines.length; index++) {
    const line = lines.at(index);
    if (line !== undefined && line.text.trim() !== "") {
      return index;
    }
  }
  return null;
};

type EntryTitle =
  | { status: "not-entry" }
  | { status: "entry"; title: number | null };

type FindEntryTitleOptions = {
  issue: SkCollectionIssue;
  lines: readonly IssueLine[];
  index: number;
  line: IssueLine;
};

const findEntryTitle = ({
  issue,
  lines,
  index,
  line,
}: FindEntryTitleOptions): EntryTitle => {
  switch (issue.series) {
    case SK_COLLECTION_SERIES.NS_R: {
      if (!NS_NUMBER.test(line.text)) {
        return { status: "not-entry" };
      }
      const title = nonemptyLine(lines, index + 1);
      if (title === null || !NS_ENTRY_TITLE.test(lines.at(title)?.text ?? "")) {
        return { status: "not-entry" };
      }
      return { status: "entry", title };
    }
    case SK_COLLECTION_SERIES.NSS_ZNSS: {
      if (!NSS_NUMBER.test(line.text)) {
        return { status: "not-entry" };
      }
      const title = lines.findIndex(
        (candidate, position) =>
          position > index &&
          position < index + 40 &&
          LEGAL_SENTENCE_TITLE.test(candidate.text),
      );
      return { status: "entry", title: title === -1 ? null : title };
    }
    default: {
      issue.series satisfies never;
      return panic("Unknown Slovak collection series");
    }
  }
};

type ParseEntryOptions = {
  issue: SkCollectionIssue;
  lines: readonly IssueLine[];
  line: IssueLine;
  title: number | null;
};

type ParsedEntry =
  | { type: "record"; record: SkCollectionRecord }
  | { type: "defect"; defect: SkCollectionDefect };

const parseEntry = ({
  issue,
  lines,
  line,
  title,
}: ParseEntryOptions): ParsedEntry => {
  const statedNumber = line.text.trim();
  const defect = (type: SkCollectionDefect["type"]): ParsedEntry => ({
    type: "defect",
    defect: { type, page: line.page, statedNumber },
  });
  const statedYear = /\/(\d{4})/u.exec(statedNumber)?.at(1);
  if (statedYear !== undefined && Number(statedYear) !== issue.year) {
    return defect("number-year-conflict");
  }
  if (title === null) {
    return defect("unreadable-entry");
  }
  const sentenceStart = nonemptyLine(lines, title + 1);
  if (sentenceStart === null) {
    return defect("unreadable-entry");
  }
  const targetStart = lines.findIndex(
    (candidate, position) =>
      position >= sentenceStart &&
      position < sentenceStart + 100 &&
      TARGET_START.test(candidate.text),
  );
  if (targetStart === -1) {
    return defect("unreadable-entry");
  }
  const targetLines: string[] = [];
  for (const candidate of lines.slice(targetStart, targetStart + 8)) {
    targetLines.push(candidate.text);
    if (/[)\]]\s*$/u.test(candidate.text)) {
      break;
    }
  }
  const targetText = targetLines.join(" ");
  const docket = TARGET_DOCKET.exec(targetText)?.at(1)?.trim();
  const court = TARGET_COURT.exec(targetText)?.at(1)?.trim();
  const legalSentence = lines
    .slice(sentenceStart, targetStart)
    .map(({ text }) => text)
    .join("\n")
    .trim();
  if (
    docket === undefined ||
    court === undefined ||
    legalSentence.length === 0 ||
    legalSentence.length > MAX_HEADNOTE_CHARACTERS
  ) {
    return defect("unreadable-entry");
  }
  return {
    type: "record",
    record: {
      annotation: {
        series: issue.series,
        statedNumber,
        publicationYear: issue.year,
        legalSentence,
        source: {
          issueUrl: issue.url,
          page: lines.at(sentenceStart)?.page ?? line.page,
        },
      },
      target: { court, docket, ecli: ECLI.exec(targetText)?.at(0) ?? null },
    },
  };
};

/** Extracts only the headnote and the publisher's exact join coordinates. */
export const parseSkCollectionPages = (
  issue: SkCollectionIssue,
  pages: readonly SkCollectionTextPage[],
): SkCollectionParseOutcome => {
  if (issue.year < 2010) {
    return { status: "needs-ocr", reason: "before-2010" };
  }
  const lines = pages.flatMap(({ page, lines: pageLines }) =>
    pageLines.map((text) => ({ page, text })),
  );
  if (
    lines.reduce((size, { text }) => size + text.trim().length, 0) <
    MIN_TEXT_CHARACTERS
  ) {
    return { status: "needs-ocr", reason: "image-only" };
  }
  const records: SkCollectionRecord[] = [];
  const defects: SkCollectionDefect[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const entry = findEntryTitle({ issue, lines, index, line });
    if (entry.status === "not-entry") {
      continue;
    }
    const parsed = parseEntry({ issue, lines, line, title: entry.title });
    switch (parsed.type) {
      case "defect":
        defects.push(parsed.defect);
        break;
      case "record": {
        const statedNumber = parsed.record.annotation.statedNumber;
        if (seen.has(statedNumber)) {
          defects.push({
            type: "duplicate-number",
            page: line.page,
            statedNumber,
          });
          break;
        }
        seen.add(statedNumber);
        records.push(parsed.record);
        break;
      }
      default:
        parsed satisfies never;
        return panic("Unknown collection entry result");
    }
  }
  if (records.length === 0 && defects.length === 0) {
    return {
      status: "defective",
      defects: [
        {
          type: "unreadable-entry",
          page: pages.at(0)?.page ?? 1,
          statedNumber: "",
        },
      ],
    };
  }
  return defects.length > 0
    ? { status: "defective", defects }
    : { status: "parsed", records };
};

/** Exact ECLI or jurisdiction-scoped docket plus court identity; no fuzzy join. */
export const joinSkCollectionRecords = (
  records: readonly SkCollectionRecord[],
  decisions: readonly SkCollectionDecision[],
): readonly SkCollectionJoinOutcome[] =>
  records.map((record) => {
    const targetDocket = DECISION_DOCKET_GRAMMARS.SVK.parse(
      record.target.docket,
    );
    const targetCourt = courtAbbreviation({
      country: "SVK",
      court: record.target.court,
    });
    const candidates = decisions.filter((decision) => {
      if (decision.country !== "SVK") {
        return false;
      }
      if (record.target.ecli !== null) {
        return decision.ecli === record.target.ecli;
      }
      if (targetDocket === null || targetCourt === undefined) {
        return false;
      }
      return (
        courtAbbreviation(decision) === targetCourt &&
        DECISION_DOCKET_GRAMMARS.SVK.parse(decision.caseNumber)?.canonical ===
          targetDocket.canonical
      );
    });
    if (candidates.length === 0) {
      return { status: "unmatched", record };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        record,
        decisionIds: candidates.map(({ id }) => id),
      };
    }
    const decision = candidates.at(0);
    if (decision === undefined) {
      return panic("A unique collection match has no decision");
    }
    return {
      status: "matched",
      decisionId: decision.id,
      annotation: record.annotation,
    };
  });
