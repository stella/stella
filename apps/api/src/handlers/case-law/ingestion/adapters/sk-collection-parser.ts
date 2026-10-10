import { panic } from "better-result";

import { courtAbbreviation } from "@stll/api-contract/court-abbreviations";
import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { Temporal } from "@stll/time";

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
  /^\s{0,16}[([]\s{0,16}(?:rozsudok|uznesenie|stanovisko)\s{1,16}(.{1,256}?)\s{1,16}(?:z\s|sp\.\s*zn\.)/iu;
const ECLI = /ECLI:SK:[A-Z\d]+:\d{4}:[A-Z\d.]+/u;
const MIN_TEXT_CHARACTERS = 100;
const MAX_HEADNOTE_CHARACTERS = 3000;
const REASONS_START = /^\s*Z\s+odôvodnenia\b/iu;
const MONTHS: Record<string, number> = {
  januára: 1,
  februára: 2,
  marca: 3,
  apríla: 4,
  mája: 5,
  júna: 6,
  júla: 7,
  augusta: 8,
  septembra: 9,
  októbra: 10,
  novembra: 11,
  decembra: 12,
};

const statedDecisionDate = (text: string): string | null => {
  const match = /\bz\s+(\d{1,2})\.\s*(\p{L}+|\d{1,2}\.)\s*(\d{4})\b/iu.exec(
    text,
  );
  if (match === null) {
    return null;
  }
  const day = Number(match.at(1));
  const monthText = match.at(2)?.toLowerCase() ?? "";
  const month = MONTHS[monthText] ?? Number(monthText.replace(".", ""));
  const year = Number(match.at(3));
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > Temporal.PlainYearMonth.from({ year, month }).daysInMonth
  ) {
    return null;
  }
  return Temporal.PlainDate.from({ year, month, day }).toString();
};

const isEntryNumber = (issue: SkCollectionIssue, text: string) =>
  issue.series === SK_COLLECTION_SERIES.NS_R
    ? NS_NUMBER.test(text)
    : NSS_NUMBER.test(text);

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
      if (
        title === null ||
        lines.at(title)?.page !== line.page ||
        !NS_ENTRY_TITLE.test(lines.at(title)?.text ?? "")
      ) {
        return { status: "not-entry" };
      }
      return { status: "entry", title };
    }
    case SK_COLLECTION_SERIES.NSS_ZNSS: {
      if (!NSS_NUMBER.test(line.text)) {
        return { status: "not-entry" };
      }
      for (
        let position = index + 1;
        position < Math.min(index + 40, lines.length);
        position++
      ) {
        const candidate = lines.at(position);
        if (
          candidate === undefined ||
          candidate.page !== line.page ||
          isEntryNumber(issue, candidate.text) ||
          REASONS_START.test(candidate.text)
        ) {
          break;
        }
        if (LEGAL_SENTENCE_TITLE.test(candidate.text)) {
          return { status: "entry", title: position };
        }
      }
      // Contents/register numbers are not entries without a legal-sentence heading.
      return { status: "not-entry" };
    }
    default: {
      issue.series satisfies never;
      return panic("Unknown Slovak collection series");
    }
  }
};

type FindTargetOptions = {
  issue: SkCollectionIssue;
  lines: readonly IssueLine[];
  sentenceStart: number;
};

const findTarget = ({ issue, lines, sentenceStart }: FindTargetOptions) => {
  let sentenceCharacters = 0;
  for (let position = sentenceStart; position < lines.length; position++) {
    const candidate = lines.at(position);
    const previous = lines.at(position - 1);
    if (
      candidate === undefined ||
      REASONS_START.test(candidate.text) ||
      isEntryNumber(issue, candidate.text) ||
      (previous !== undefined && candidate.page > previous.page + 1)
    ) {
      break;
    }
    if (TARGET_START.test(candidate.text)) {
      return position;
    }
    sentenceCharacters += candidate.text.length + 1;
    if (sentenceCharacters > MAX_HEADNOTE_CHARACTERS) {
      break;
    }
  }
  return -1;
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
  if (
    sentenceStart === null ||
    (lines.at(sentenceStart)?.page ?? line.page) > line.page + 1
  ) {
    return defect("unreadable-entry");
  }
  const targetStart = findTarget({ issue, lines, sentenceStart });
  if (targetStart === -1) {
    return defect("unreadable-entry");
  }
  const targetLines: string[] = [];
  let targetClosed = false;
  for (const candidate of lines.slice(targetStart, targetStart + 8)) {
    if (
      REASONS_START.test(candidate.text) ||
      isEntryNumber(issue, candidate.text)
    ) {
      break;
    }
    targetLines.push(candidate.text);
    if (/[)\]]\s*$/u.test(candidate.text)) {
      targetClosed = true;
      break;
    }
  }
  if (!targetClosed) {
    return defect("unreadable-entry");
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
      target: {
        court,
        docket,
        ecli: ECLI.exec(targetText)?.at(0) ?? null,
        decisionDate: statedDecisionDate(targetText),
      },
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
  const textPages = pages.filter(
    ({ lines }) =>
      lines.reduce((size, text) => size + text.trim().length, 0) >=
      MIN_TEXT_CHARACTERS,
  );
  if (textPages.length === 0) {
    return { status: "needs-ocr", reason: "image-only" };
  }
  const lines = textPages.flatMap(({ page, lines: pageLines }) =>
    pageLines.map((text) => ({ page, text })),
  );
  const records: SkCollectionRecord[] = [];
  const defects: SkCollectionDefect[] = pages
    .filter((page) => !textPages.includes(page))
    .map(({ page }) => ({ type: "needs-ocr", page, statedNumber: "" }));
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
  if (defects.length === 0) {
    return { status: "parsed", records };
  }
  return records.length > 0
    ? { status: "partial", records, defects }
    : { status: "defective", defects };
};

/** Stated date plus exact ECLI or jurisdiction-scoped docket and court; no fuzzy join. */
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
      if (
        decision.country !== "SVK" ||
        record.target.decisionDate === null ||
        decision.decisionDate !== record.target.decisionDate
      ) {
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
