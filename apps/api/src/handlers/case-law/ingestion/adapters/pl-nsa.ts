/**
 * Polish administrative courts, imported from the Hugging Face dataset
 * `JuDDGES/pl-nsa` (CC BY 4.0).
 *
 * The dataset holds the decisions of the Supreme Administrative Court (NSA)
 * and the sixteen voivodeship administrative courts (WSA), the NSA's
 * pre-2004 decisions from Warsaw and its branch seats, and a few thousand
 * Supreme Court and Constitutional Tribunal decisions filed in the same
 * collection. One row is one decision, keyed by the court portal's own
 * document id, so a later import from another channel lands on the same rows.
 *
 * The walk is a fixed set (rule 19): the pinned revision's shards in order,
 * a window of rows at a time. The cursor is `<revision>:<shard>:<row>`, the
 * next row to read; past the last shard it parks and asks for nothing. The
 * reconciliation slices are the shards themselves, listed by id alone.
 */

import { Result, panic } from "better-result";
import * as v from "valibot";

import {
  DECISION_DASH_CLASS_SOURCE,
  polishAdministrativeDocketOf,
} from "@stll/api-contract/decision-docket-grammar";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
} from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";
import { Temporal } from "@stll/time";

import { ADAPTER_KEYS, PARSER_VERSIONS } from "@/api/handlers/case-law/consts";
import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  isPersistableSourceDocumentId,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
  excludedSourceSurface,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
  IngestionResult,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  huggingFaceShardSource,
  PL_NSA_SNAPSHOT,
  plNsaShardUrl,
  plNsaSnapshotRows,
  readPlNsaListing,
  readPlNsaRows,
} from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import type {
  PlNsaDatasetRow,
  PlNsaShard,
  PlNsaShardSource,
  PlNsaSnapshot,
} from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  parsePlNsaDecision,
  plNsaSectionHeading,
  PL_NSA_TEXT_SECTIONS,
} from "@/api/handlers/case-law/ingestion/parsers/pl-nsa";
import type {
  PlNsaSectionTexts,
  PlNsaTextSection,
} from "@/api/handlers/case-law/ingestion/parsers/pl-nsa";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { arrayOrEmpty } from "@/api/lib/array";
import {
  absentDecisionTextFields,
  absentTextField,
  checkedDecisionMetadata,
  sourceTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

const PL_NSA_LANGUAGE = "pl";

const PL_NSA_COUNTRY = ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_NSA].country;

/**
 * The terms the source row is kept under, for the operator's source row.
 *
 * The packaging is licensed CC BY 4.0, which asks for attribution and allows
 * redistribution; the decisions themselves are official documents, which
 * Polish copyright law leaves unprotected. Both halves allow serving the text
 * and reading it with AI, so redistribution is allowed deliberately, not by
 * the legacy default.
 */
export const PL_NSA_SOURCE_DESCRIPTOR = {
  license: "cc-by",
  attribution: "JuDDGES/pl-nsa (Hugging Face), CC BY 4.0",
  allowsRedistribution: true,
  allowsDerivedAi: true,
} as const satisfies CorpusSourceDescriptor;

// ── Dataset columns ──────────────────────────────────────

/** Every column the pinned revision states, in the dataset's own order. */
const SOURCE_COLUMNS = [
  "country",
  "court_type",
  "source",
  "judgment_id",
  "docket_number",
  "judgment_type",
  "finality",
  "judgment_date",
  "submission_date",
  "court_name",
  "judges",
  "presiding_judge",
  "judge_rapporteur",
  "case_type_description",
  "keywords",
  "related_docket_numbers",
  "challenged_authority",
  "decision",
  "extracted_legal_bases",
  "official_collection",
  "glosa_information",
  "thesis",
  "sentence",
  "reasons_for_judgment",
  "dissenting_opinion",
  "full_text",
] as const;

/** Fields inside the two list-of-struct columns, named `column.field`. */
const SOURCE_NESTED_FIELDS = [
  "related_docket_numbers.judgment_id",
  "related_docket_numbers.docket_number",
  "related_docket_numbers.judgment_date",
  "related_docket_numbers.judgment_type",
  "extracted_legal_bases.link",
  "extracted_legal_bases.article",
  "extracted_legal_bases.journal",
  "extracted_legal_bases.law",
] as const;

type SourceField =
  | (typeof SOURCE_COLUMNS)[number]
  | (typeof SOURCE_NESTED_FIELDS)[number];

// ── Normalization ────────────────────────────────────────

const WARSAW = "Europe/Warsaw";

/**
 * A dataset timestamp as an ISO instant with the Warsaw offset. The parquet
 * reader hands back a `Date`, the dataset viewer an ISO string; both become
 * the same string, so a row hashes the same whichever way it was read.
 */
/** A timestamp the row states in a form no instant can be read from. */
type UnreadableTimestamp = { readonly type: "unreadable" };

const UNREADABLE: UnreadableTimestamp = { type: "unreadable" };

/** Epoch milliseconds as an instant, or unreadable: never a throw. */
const instantOfMilliseconds = (
  milliseconds: number,
): Result<Temporal.Instant, UnreadableTimestamp> =>
  Number.isSafeInteger(milliseconds)
    ? Result.try({
        try: () => Temporal.Instant.fromEpochMilliseconds(milliseconds),
        catch: () => UNREADABLE,
      })
    : Result.err(UNREADABLE);

/**
 * The instant a dataset timestamp states: `null` where it states none, and
 * unreadable — never a throw — where what it states is not an instant (an
 * invalid date, a fractional or out-of-range count, a malformed string). A
 * throw here would fail every page the row sits on, for good.
 */
const instantOf = (
  value: unknown,
): Result<Temporal.Instant | null, UnreadableTimestamp> => {
  if (value === null || value === undefined) {
    return Result.ok(null);
  }
  if (value instanceof Date) {
    return instantOfMilliseconds(value.getTime());
  }
  if (typeof value === "number") {
    return instantOfMilliseconds(value);
  }
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? instantOfMilliseconds(Number(value))
      : Result.err(UNREADABLE);
  }
  if (typeof value !== "string") {
    return Result.err(UNREADABLE);
  }
  return Result.try({
    try: () => Temporal.Instant.from(value),
    catch: () => UNREADABLE,
  });
};

/**
 * A dataset timestamp as an ISO instant with the Warsaw offset, or `null`.
 * An unreadable one reads as `null` here; `unreadableTimestamps` is what
 * keeps such a row from being stored as if it stated no date.
 */
const warsawTimestamp = (value: unknown): string | null => {
  const read = instantOf(value);
  return Result.isOk(read) && read.value !== null
    ? read.value.toZonedDateTimeISO(WARSAW).toString({ timeZoneName: "never" })
    : null;
};

/** The timestamp fields of a row that state something no instant reads from. */
export const unreadableTimestamps = (
  source: PlNsaDatasetRow,
): readonly string[] => {
  const unreadable = (value: unknown): boolean =>
    Result.isError(instantOf(value));
  const related = source["related_docket_numbers"];
  const relatedItems: unknown[] = Array.isArray(related) ? related : [];
  return [
    ...(["judgment_date", "submission_date"] as const).filter((column) =>
      unreadable(source[column]),
    ),
    ...relatedItems.flatMap((item, index) =>
      isRecord(item) && unreadable(item["judgment_date"])
        ? [`related_docket_numbers[${index}].judgment_date`]
        : [],
    ),
  ];
};

/** The Warsaw calendar day of a normalized timestamp. */
const warsawDate = (timestamp: string | null): string | undefined =>
  timestamp === null
    ? undefined
    : Temporal.Instant.from(timestamp)
        .toZonedDateTimeISO(WARSAW)
        .toPlainDate()
        .toString();

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const nonEmpty = (value: unknown): string | null => {
  const read = text(value)?.trim();
  return read === undefined || read.length === 0 ? null : read;
};

const textList = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" ? [item] : []))
    : null;

type RelatedDocket = {
  judgment_id: string | null;
  docket_number: string | null;
  judgment_date: string | null;
  judgment_type: string | null;
};

type LegalBasis = {
  link: string | null;
  article: string | null;
  journal: string | null;
  law: string | null;
};

const structList = <T>(
  value: unknown,
  read: (item: Record<string, unknown>) => T,
): T[] | null =>
  Array.isArray(value)
    ? value.flatMap((item) => (isRecord(item) ? [read(item)] : []))
    : null;

/** One dataset row with every known column in its normalized form. */
export type PlNsaRow = {
  country: string | null;
  court_type: string | null;
  source: string | null;
  judgment_id: string | null;
  docket_number: string | null;
  judgment_type: string | null;
  finality: string | null;
  judgment_date: string | null;
  submission_date: string | null;
  court_name: string | null;
  judges: string[] | null;
  presiding_judge: string | null;
  judge_rapporteur: string | null;
  case_type_description: string[] | null;
  keywords: string[] | null;
  related_docket_numbers: RelatedDocket[] | null;
  challenged_authority: string | null;
  decision: string[] | null;
  extracted_legal_bases: LegalBasis[] | null;
  official_collection: string[] | null;
  glosa_information: string[] | null;
  thesis: string | null;
  sentence: string | null;
  reasons_for_judgment: string | null;
  dissenting_opinion: string | null;
  full_text: string | null;
};

export const normalizePlNsaRow = (row: PlNsaDatasetRow): PlNsaRow => ({
  country: text(row["country"]),
  court_type: text(row["court_type"]),
  source: text(row["source"]),
  judgment_id: text(row["judgment_id"]),
  docket_number: text(row["docket_number"]),
  judgment_type: text(row["judgment_type"]),
  finality: text(row["finality"]),
  judgment_date: warsawTimestamp(row["judgment_date"]),
  submission_date: warsawTimestamp(row["submission_date"]),
  court_name: text(row["court_name"]),
  judges: textList(row["judges"]),
  presiding_judge: text(row["presiding_judge"]),
  judge_rapporteur: text(row["judge_rapporteur"]),
  case_type_description: textList(row["case_type_description"]),
  keywords: textList(row["keywords"]),
  related_docket_numbers: structList(row["related_docket_numbers"], (item) => ({
    judgment_id: text(item["judgment_id"]),
    docket_number: text(item["docket_number"]),
    judgment_date: warsawTimestamp(item["judgment_date"]),
    judgment_type: text(item["judgment_type"]),
  })),
  challenged_authority: text(row["challenged_authority"]),
  decision: textList(row["decision"]),
  extracted_legal_bases: structList(row["extracted_legal_bases"], (item) => ({
    link: text(item["link"]),
    article: text(item["article"]),
    journal: text(item["journal"]),
    law: text(item["law"]),
  })),
  official_collection: textList(row["official_collection"]),
  glosa_information: textList(row["glosa_information"]),
  thesis: text(row["thesis"]),
  sentence: text(row["sentence"]),
  reasons_for_judgment: text(row["reasons_for_judgment"]),
  dissenting_opinion: text(row["dissenting_opinion"]),
  full_text: text(row["full_text"]),
});

// ── Text sections ────────────────────────────────────────

const sectionTexts = (row: PlNsaRow): PlNsaSectionTexts => ({
  thesis: row.thesis,
  sentence: row.sentence,
  reasons: row.reasons_for_judgment,
  dissent: row.dissenting_opinion,
});

/**
 * The dataset's `full_text`, rebuilt from the four section columns the way
 * the dataset builds it: each present section under its upper-cased heading,
 * sections separated by two blank lines.
 */
export const composePlNsaFullText = (row: PlNsaRow): string =>
  PL_NSA_TEXT_SECTIONS.flatMap((section) => {
    const body = sectionTexts(row)[section];
    return body === null
      ? []
      : [
          `${plNsaSectionHeading(section).toLocaleUpperCase("pl-PL")}\n\n${body}`,
        ];
  }).join("\n\n\n");

type SectionPresence = "present" | "absent";

const sectionPresence = (
  row: PlNsaRow,
): Record<PlNsaTextSection, SectionPresence> => {
  const texts = sectionTexts(row);
  const of = (section: PlNsaTextSection): SectionPresence =>
    (texts[section]?.trim().length ?? 0) > 0 ? "present" : "absent";
  return {
    thesis: of("thesis"),
    sentence: of("sentence"),
    reasons: of("reasons"),
    dissent: of("dissent"),
  };
};

// ── Identity ─────────────────────────────────────────────

/** The portal's document path as the dataset states it: `/doc/<10 hex>`. */
const DOCUMENT_PATH = /^\/doc\/(?<id>[0-9A-F]{10})$/u;

/**
 * The court portal's own id for the decision, or the dataset's value where it
 * is not in the portal's form. Only the first is an id another channel can
 * share, so only it gets a public link.
 */
export const plNsaDocumentId = (
  judgmentId: string | null,
): { id: string; portal: boolean } | null => {
  if (judgmentId === null) {
    return null;
  }
  const portalId = DOCUMENT_PATH.exec(judgmentId)?.groups?.["id"];
  if (portalId !== undefined) {
    return { id: portalId, portal: true };
  }
  return isPersistableSourceDocumentId(judgmentId)
    ? { id: judgmentId, portal: false }
    : null;
};

export const plNsaPortalUrl = (id: string): string =>
  `https://orzeczenia.nsa.gov.pl/doc/${id}`;

const normalizeDocket = (docket: string | null): string | null => {
  const collapsed = docket?.replaceAll(/\s+/gu, " ").trim();
  return collapsed === undefined || collapsed.length === 0 ? null : collapsed;
};

/** The docket as the grammar reads it, or the source's own when it reads none. */
export type PlNsaDocket = {
  caseNumber: string;
  recognised: boolean;
};

export const plNsaDocket = (published: string | null): PlNsaDocket | null => {
  const collapsed = normalizeDocket(published);
  if (collapsed === null) {
    return null;
  }
  const recognised = polishAdministrativeDocketOf(collapsed);
  return recognised === null
    ? { caseNumber: collapsed, recognised: false }
    : { caseNumber: recognised, recognised: true };
};

/** "I SA 1234-1236/98": one docket naming several joined cases. */
const DOCKET_RANGE = new RegExp(
  String.raw`^(?<prefix>.*?)(?<from>\d{1,6})[${DECISION_DASH_CLASS_SOURCE}](?<to>\d{1,6})(?<suffix>\/\d{2}(?:\d{2})?)$`,
  "u",
);

/**
 * Each case a joined docket names, so a citation of one of them ("I SA
 * 1235/98") finds the decision. Only a recognised docket is expanded, only
 * ascending ranges, and only as many as the row's identifiers can hold.
 */
export const plNsaDocketRangeMembers = (
  docket: PlNsaDocket,
): readonly string[] => {
  const groups = docket.recognised
    ? DOCKET_RANGE.exec(docket.caseNumber)?.groups
    : undefined;
  const from = Number(groups?.["from"]);
  const to = Number(groups?.["to"]);
  if (
    groups === undefined ||
    !(to > from) ||
    to - from + 2 > DECISION_IDENTIFIER_MAX_COUNT
  ) {
    return [];
  }
  const prefix = groups["prefix"] ?? "";
  const suffix = groups["suffix"] ?? "";
  return Array.from(
    { length: to - from + 1 },
    (_, offset) => `${prefix}${from + offset}${suffix}`,
  ).filter((member) => polishAdministrativeDocketOf(member) === member);
};

const docketIdentifiers = (
  caseNumber: string,
  members: readonly string[],
): DecisionIdentifiers => [
  { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: caseNumber },
  ...members.map((value) => ({
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value,
  })),
];

// ── Courts ───────────────────────────────────────────────

const NSA = "Naczelny Sąd Administracyjny";
const SN = "Sąd Najwyższy";
const TK = "Trybunał Konstytucyjny";
const WSA = "Wojewódzki Sąd Administracyjny";

export const PL_NSA_COURT_LEVELS = [
  "supreme-administrative",
  "regional-administrative",
  "supreme",
  "constitutional",
  /** A court the record names that this table does not know. */
  "unrecognised",
] as const;

type CourtLevel = (typeof PL_NSA_COURT_LEVELS)[number];

/** Which field of the record the court was read from. */
type CourtStatedBy = "court-name" | "decision-form";

export type PlNsaCourt = {
  /** The court's full official name, the key its rank and roster use. */
  name: string;
  level: CourtLevel;
  statedBy: CourtStatedBy;
  /** The seat's docket abbreviation, for a regional court. */
  seat?: string | undefined;
  /** The NSA's branch seat before 2004, as the source names it. */
  branch?: string | undefined;
  /** Set for the NSA as it sat before the 2004 reform. */
  era?: "pre-2004" | undefined;
};

type KnownCourt = Omit<PlNsaCourt, "statedBy">;

/** The sixteen regional courts: the seat as printed, as named, its mark. */
const REGIONAL_COURTS = [
  ["w Białymstoku", "w Białymstoku", "Bk"],
  ["w Bydgoszczy", "w Bydgoszczy", "Bd"],
  ["w Gdańsku", "w Gdańsku", "Gd"],
  ["w Gliwicach", "w Gliwicach", "Gl"],
  ["w Gorzowie Wlkp.", "w Gorzowie Wielkopolskim", "Go"],
  ["w Kielcach", "w Kielcach", "Ke"],
  ["w Krakowie", "w Krakowie", "Kr"],
  ["w Lublinie", "w Lublinie", "Lu"],
  ["w Łodzi", "w Łodzi", "Łd"],
  ["w Olsztynie", "w Olsztynie", "Ol"],
  ["w Opolu", "w Opolu", "Op"],
  ["w Poznaniu", "w Poznaniu", "Po"],
  ["w Rzeszowie", "w Rzeszowie", "Rz"],
  ["w Szczecinie", "w Szczecinie", "Sz"],
  ["w Warszawie", "w Warszawie", "Wa"],
  ["we Wrocławiu", "we Wrocławiu", "Wr"],
] as const;

const REGIONAL_BY_SEAT = new Map<string, KnownCourt>(
  REGIONAL_COURTS.map(([printed, official, seat]) => [
    printed,
    { name: `${WSA} ${official}`, level: "regional-administrative", seat },
  ]),
);

const COURTS_BY_PUBLISHED_NAME = new Map<string, KnownCourt>([
  [NSA, { name: NSA, level: "supreme-administrative" }],
  [
    "NSA w Warszawie (przed reformą)",
    { name: NSA, level: "supreme-administrative", era: "pre-2004" },
  ],
  [SN, { name: SN, level: "supreme" }],
  [TK, { name: TK, level: "constitutional" }],
  ...[...REGIONAL_BY_SEAT].map(
    ([printed, court]) => [`${WSA} ${printed}`, court] as const,
  ),
]);

/** "NSA oz. w Gdańsku": a branch seat (ośrodek zamiejscowy) of the old NSA. */
const PRE_REFORM_BRANCH = /^NSA oz\. (?<seat>we? \p{Lu}.*)$/u;

const preReformBranch = (seat: string): KnownCourt => ({
  name: NSA,
  level: "supreme-administrative",
  era: "pre-2004",
  branch: `Ośrodek Zamiejscowy ${seat}`,
});

const courtOfName = (published: string): KnownCourt | null => {
  const known = COURTS_BY_PUBLISHED_NAME.get(published);
  if (known !== undefined) {
    return known;
  }
  const seat = PRE_REFORM_BRANCH.exec(published)?.groups?.["seat"];
  return seat === undefined ? null : preReformBranch(seat);
};

/**
 * The court a decision label names ("Wyrok WSA w Opolu", "Uchwała Składu
 * Siedmiu Sędziów NSA", "Postanowienie Sądu Najwyższego"). A second reading
 * of the record, used to check the court name and to stand in for it where
 * the row states none.
 */
const DECISION_FORM_COURTS: readonly (readonly [
  RegExp,
  (groups: Record<string, string | undefined>) => KnownCourt | null,
])[] = [
  [
    /\bWSA (?<seat>we? \p{Lu}.*)$/u,
    (groups) => REGIONAL_BY_SEAT.get(groups["seat"] ?? "") ?? null,
  ],
  [
    /\bNSA oz\. (?<seat>we? \p{Lu}.*)$/u,
    (groups) =>
      groups["seat"] === undefined ? null : preReformBranch(groups["seat"]),
  ],
  [/\bNSA$/u, () => ({ name: NSA, level: "supreme-administrative" })],
  [/Sądu Najwyższego$/u, () => ({ name: SN, level: "supreme" })],
  [
    /Trybunału Konstytucyjnego$/u,
    () => ({ name: TK, level: "constitutional" }),
  ],
];

const courtOfDecisionForm = (label: string): KnownCourt | null => {
  for (const [pattern, read] of DECISION_FORM_COURTS) {
    const match = pattern.exec(label);
    if (match !== null) {
      return read(match.groups ?? {});
    }
  }
  return null;
};

/**
 * The deciding court, read off the record: the row's court name, and where it
 * states none, the decision label, which names the court too. Nothing is
 * defaulted. A court name outside the table is kept as printed with an
 * `unrecognised` level and reported; a label naming a different court than
 * the court name is reported, and the court name stands. A row naming no
 * court anywhere yields `null`, which the caller refuses to store.
 */
export const plNsaCourt = (
  courtName: string | null,
  decisionForm: string | null,
): PlNsaCourt | null => {
  const fromForm =
    decisionForm === null ? null : courtOfDecisionForm(decisionForm);
  const published = nonEmpty(courtName);
  if (published === null) {
    return fromForm === null
      ? null
      : { ...fromForm, statedBy: "decision-form" };
  }
  const fromName = courtOfName(published);
  if (fromName === null) {
    logger.warn("case_law.ingestion.court_unrecognised", {
      adapterKey: ADAPTER_KEYS.PL_NSA,
      court: published,
    });
    return { name: published, level: "unrecognised", statedBy: "court-name" };
  }
  if (fromForm !== null && fromForm.name !== fromName.name) {
    logger.warn("case_law.ingestion.court_conflict", {
      adapterKey: ADAPTER_KEYS.PL_NSA,
      court: published,
      decisionForm: decisionForm ?? "",
    });
  }
  return { ...fromName, statedBy: "court-name" };
};

// ── Decision kinds ───────────────────────────────────────

/** The kinds the source's decision label opens with, in the local language. */
const DECISION_KINDS = {
  Wyrok: "wyrok",
  Postanowienie: "postanowienie",
  Uchwała: "uchwała",
  Orzeczenie: "orzeczenie",
} as const;

const isDecisionKindWord = (
  word: string,
): word is keyof typeof DECISION_KINDS => Object.hasOwn(DECISION_KINDS, word);

export const PL_NSA_BENCHES = [
  "seven-judges",
  "five-judges",
  "full-chamber",
  "joined-chambers",
  "chamber",
] as const;

type Bench = (typeof PL_NSA_BENCHES)[number];

/** Enlarged benches the label names, most specific first. */
const BENCH_MARKS: readonly (readonly [RegExp, Bench])[] = [
  [/Składu Siedmiu Sędziów/u, "seven-judges"],
  [/Składu Pięciu Sędziów/u, "five-judges"],
  [/Pełnego Składu Izby|Składu Całej Izby/u, "full-chamber"],
  [/Połączonych Izb/u, "joined-chambers"],
  [/Składu Izby/u, "chamber"],
];

export type PlNsaDecisionKind = {
  /** `wyrok`, `postanowienie`, `uchwała` or `orzeczenie`; absent if unstated. */
  type: string | undefined;
  /** The enlarged bench the label names, if it names one. */
  bench: Bench | undefined;
};

/**
 * The kind of decision and its bench, read off the source's label
 * ("Uchwała Składu Siedmiu Sędziów NSA", "Wyrok WSA w Opolu"). A label that
 * opens with no kind — the source prints a bare "NSA" for a few old rows —
 * states none, and none is invented.
 */
export const plNsaDecisionKind = (label: string | null): PlNsaDecisionKind => {
  const first = label?.split(" ").at(0) ?? "";
  const type = isDecisionKindWord(first) ? DECISION_KINDS[first] : undefined;
  if (type === undefined && label !== null) {
    logger.warn("case_law.ingestion.decision_type_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_NSA,
      decisionForm: label,
    });
  }
  const bench =
    label === null
      ? undefined
      : BENCH_MARKS.find(([mark]) => mark.test(label))?.[1];
  return { type, bench };
};

// ── Finality ─────────────────────────────────────────────

const FINALITY_STATUSES = {
  "orzeczenie prawomocne": "final",
  "orzeczenie nieprawomocne": "not-final",
} as const;

type FinalityStatus =
  | (typeof FINALITY_STATUSES)[keyof typeof FINALITY_STATUSES]
  | "not-stated"
  | "unrecognised";

export type PlNsaFinality = {
  status: FinalityStatus;
  /** The label as the source prints it. */
  asPublished: string | null;
  /** The day the label was read; a decision becomes final after it. */
  asOf: string;
};

const isFinalityLabel = (
  label: string,
): label is keyof typeof FINALITY_STATUSES =>
  Object.hasOwn(FINALITY_STATUSES, label);

export const plNsaFinality = (
  label: string | null,
  asOf: string,
): PlNsaFinality => {
  if (label === null) {
    return { status: "not-stated", asPublished: null, asOf };
  }
  return {
    status: isFinalityLabel(label) ? FINALITY_STATUSES[label] : "unrecognised",
    asPublished: label,
    asOf,
  };
};

// ── Case symbols ─────────────────────────────────────────

/** "6110 Podatek od towarów i usług": the court's case symbol and its name. */
const CASE_SYMBOL = /^(?<code>\d{3,4})(?:\s(?<description>.*))?$/u;

export type PlNsaCaseSymbol = {
  code: string | null;
  description: string | null;
  asPublished: string;
};

const caseSymbol = (asPublished: string): PlNsaCaseSymbol => {
  const groups = CASE_SYMBOL.exec(asPublished.trim())?.groups;
  return {
    code: groups?.["code"] ?? null,
    description: nonEmpty(groups?.["description"]),
    asPublished,
  };
};

// ── Assembly ─────────────────────────────────────────────

/** Where a row sits in the pinned revision. */
export type PlNsaPosition = { shard: PlNsaShard; row: number };

/** The parts of the stored raw envelope. */
const RAW_PART = {
  ROW: "row",
  SNAPSHOT: "snapshot",
} as const;

type SnapshotPart = {
  repository: string;
  revision: string;
  snapshotDate: string;
  shard: string;
  row: number;
};

/**
 * A value as the reader handed it over, in a form JSON holds without loss:
 * a timestamp as the epoch milliseconds the file stores, a 64-bit integer as
 * its digits, bytes as base64. Nothing is renamed, reordered or dropped.
 */
const verbatim = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(verbatim);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, verbatim(item)]),
    );
  }
  return value ?? null;
};

/** The row as the source served it, every column in the source's order. */
const verbatimRow = (source: PlNsaDatasetRow): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(source).map(([column, value]) => [column, verbatim(value)]),
  );

// ── Identity ─────────────────────────────────────────────

const QUARANTINE_PREFIX = "pl-nsa-quarantine:";

type PlNsaIdentity = {
  id: string;
  /**
   * `portal`: the court portal's own id. `dataset`: the dataset's value, not
   * in the portal's form. `quarantine`: the row states no usable id, and is
   * kept under a fingerprint of what it does state.
   */
  kind: "portal" | "dataset" | "quarantine";
};

/**
 * The audit identity of a row with no usable publisher id: a hash of the
 * columns that tell a decision apart — docket, decision form, decision date,
 * filing date and court — as the row states them. Built from the columns the
 * reconciliation listing reads too, so both key the row the same way; and
 * emitted as a repair-only alias by every row that does state an id, so a
 * revision in which the id recovers enriches the quarantined row instead of
 * inserting a second one.
 */
export const plNsaQuarantineId = (source: PlNsaDatasetRow): string => {
  const row = normalizePlNsaRow(source);
  return `${QUARANTINE_PREFIX}${hashContent(
    JSON.stringify([
      normalizeDocket(row.docket_number),
      row.judgment_type,
      row.judgment_date,
      row.submission_date,
      row.court_name,
    ]),
  )}`;
};

export const plNsaIdentityOf = (source: PlNsaDatasetRow): PlNsaIdentity => {
  const document = plNsaDocumentId(text(source["judgment_id"]));
  if (document === null) {
    return { id: plNsaQuarantineId(source), kind: "quarantine" };
  }
  return { id: document.id, kind: document.portal ? "portal" : "dataset" };
};

export type AssemblePlNsaDecisionOptions = {
  source: PlNsaDatasetRow;
  position: PlNsaPosition;
  snapshot: PlNsaSnapshot;
};

type PlNsaBuildResult = { type: "built"; decision: IngestionResult };

/**
 * The court label of a row that names no court in any field. Not a court:
 * the row carrying it is stored listing-only, so it is never published under
 * this label, and `metadata.quarantine` says why. A repair that learns the
 * court replaces it.
 */
export const PL_NSA_UNSTATED_COURT = "(sąd nieustalony)";

export const PL_NSA_QUARANTINE_REASON = {
  COURT_UNSTATED: "court-unstated",
  TIMESTAMP_UNREADABLE: "timestamp-unreadable",
} as const;

type QuarantineReason =
  (typeof PL_NSA_QUARANTINE_REASON)[keyof typeof PL_NSA_QUARANTINE_REASON];

type QuarantineOptions = {
  reason: QuarantineReason;
  /** The fields the reason concerns, where it concerns some. */
  fields?: readonly string[] | undefined;
  source: PlNsaDatasetRow;
  row: PlNsaRow;
  identity: PlNsaIdentity;
  position: PlNsaPosition;
  snapshot: PlNsaSnapshot;
  sourceRaw: string;
  snapshotPart: SnapshotPart;
};

/**
 * A row the record does not state enough of to store as a decision — no
 * court, or a timestamp nothing reads — kept rather than dropped or given a
 * value it does not state: stored listing-only, so it stays out of every
 * public read, with its verbatim row, its reason and its identity, and the
 * crawl moves past it. The warning is the count an operator sweeps for.
 */
const quarantined = ({
  fields,
  identity,
  position,
  reason,
  row,
  snapshotPart,
  source,
  sourceRaw,
}: QuarantineOptions): IngestionResult => {
  logger.warn("case_law.ingestion.row_quarantined", {
    adapterKey: ADAPTER_KEYS.PL_NSA,
    reason,
    documentId: identity.id,
    position: `${position.shard.path}:${position.row}`,
    ...(fields === undefined ? {} : { fields: fields.join(",") }),
  });
  const docket = plNsaDocket(row.docket_number);
  const caseNumber =
    docket?.caseNumber ?? `orzeczenia.nsa.gov.pl/doc/${identity.id}`;
  const decisionDate = warsawDate(row.judgment_date);
  return {
    caseNumber,
    ...(docket === null ? { caseNumberIsPlaceholder: true } : {}),
    isListingOnly: true,
    sourceDocumentId: identity.id,
    ...(identity.kind === "quarantine"
      ? {}
      : { sourceDocumentIdRepairAliases: [plNsaQuarantineId(source)] }),
    court: PL_NSA_UNSTATED_COURT,
    country: PL_NSA_COUNTRY,
    language: PL_NSA_LANGUAGE,
    decisionDate,
    sourceUrl:
      identity.kind === "portal" ? plNsaPortalUrl(identity.id) : undefined,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      caseNumber,
      decisionDate,
      documentId: identity.id,
      identityKind: identity.kind,
      docketAsPublished: row.docket_number ?? undefined,
      courtAsPublished: row.court_name ?? undefined,
      decisionForm: row.judgment_type ?? undefined,
      quarantine: {
        reason,
        ...(fields === undefined ? {} : { fields: [...fields] }),
      },
      dataset: {
        ...snapshotPart,
        country: row.country,
        courtType: row.court_type,
        source: row.source,
      },
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_NSA],
    documentAst: EMPTY_AST,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

const judgesOf = (row: PlNsaRow): DecisionJudgeInput[] | undefined => {
  if (
    row.judges === null &&
    row.presiding_judge === null &&
    row.judge_rapporteur === null
  ) {
    return undefined;
  }
  return [
    ...(row.presiding_judge === null
      ? []
      : [
          {
            role: DECISION_JUDGE_ROLE.PRESIDING,
            nameAsPrinted: row.presiding_judge,
          },
        ]),
    ...(row.judge_rapporteur === null
      ? []
      : [
          {
            role: DECISION_JUDGE_ROLE.RAPPORTEUR,
            nameAsPrinted: row.judge_rapporteur,
          },
        ]),
    ...arrayOrEmpty(row.judges).map((name) => ({
      role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
      nameAsPrinted: name,
    })),
  ];
};

/**
 * Build one decision from one dataset row. No I/O: the crawl, the
 * reconciliation and a replay of the stored envelope all reach this with the
 * same row, so none of them can key or map it differently.
 */
export const assemblePlNsaDecision = ({
  position,
  snapshot,
  source,
}: AssemblePlNsaDecisionOptions): PlNsaBuildResult => {
  const row = normalizePlNsaRow(source);
  const identity = plNsaIdentityOf(source);
  if (identity.kind !== "portal") {
    logger.warn("case_law.ingestion.document_id_unrecognised", {
      adapterKey: ADAPTER_KEYS.PL_NSA,
      documentId: identity.id,
      identityKind: identity.kind,
    });
  }

  const snapshotPart: SnapshotPart = {
    repository: snapshot.repository,
    revision: snapshot.revision,
    snapshotDate: snapshot.snapshotDate,
    shard: position.shard.path,
    row: position.row,
  };
  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.ROW]: JSON.stringify(verbatimRow(source)),
    [RAW_PART.SNAPSHOT]: JSON.stringify(snapshotPart),
  });

  const quarantine = {
    source,
    row,
    identity,
    position,
    snapshot,
    sourceRaw,
    snapshotPart,
  };

  const unreadable = unreadableTimestamps(source);
  if (unreadable.length > 0) {
    return {
      type: "built",
      decision: quarantined({
        ...quarantine,
        reason: PL_NSA_QUARANTINE_REASON.TIMESTAMP_UNREADABLE,
        fields: unreadable,
      }),
    };
  }

  const court = plNsaCourt(row.court_name, row.judgment_type);
  if (court === null) {
    return {
      type: "built",
      decision: quarantined({
        ...quarantine,
        reason: PL_NSA_QUARANTINE_REASON.COURT_UNSTATED,
      }),
    };
  }

  const docket = plNsaDocket(row.docket_number);
  const caseNumber =
    docket?.caseNumber ?? `orzeczenia.nsa.gov.pl/doc/${identity.id}`;
  const rangeMembers = docket === null ? [] : plNsaDocketRangeMembers(docket);
  const kind = plNsaDecisionKind(row.judgment_type);
  const decisionDate = warsawDate(row.judgment_date);
  const sourceUrl =
    identity.kind === "portal" ? plNsaPortalUrl(identity.id) : undefined;
  const keywords = arrayOrEmpty(row.keywords);
  const citedProvisions = arrayOrEmpty(row.extracted_legal_bases);

  const parsed = parsePlNsaDecision({
    caseNumber,
    court: court.name,
    decisionDate,
    decisionType: kind.type,
    title: row.judgment_type ?? undefined,
    documentId: identity.id,
    sourceUrl: sourceUrl ?? plNsaShardUrl(snapshot, position.shard),
    keywords,
    statutes: citedProvisions.flatMap(({ article, journal }) => {
      const reference = [journal, article].filter((part) => part !== null);
      return reference.length === 0 ? [] : [reference.join(" ")];
    }),
    sections: sectionTexts(row),
    reference: row.full_text,
  });

  const decision: IngestionResult = {
    caseNumber,
    ...(docket === null ? { caseNumberIsPlaceholder: true } : {}),
    ...(rangeMembers.length === 0
      ? {}
      : { identifiers: docketIdentifiers(caseNumber, rangeMembers) }),
    sourceDocumentId: identity.id,
    ...(identity.kind === "quarantine"
      ? {}
      : { sourceDocumentIdRepairAliases: [plNsaQuarantineId(source)] }),
    court: court.name,
    country: PL_NSA_COUNTRY,
    language: PL_NSA_LANGUAGE,
    decisionDate,
    decisionType: kind.type,
    fulltext: parsed.fulltext,
    sourceUrl,
    // The thesis is the court's own statement of the point of law, printed
    // above the decision; the source carries no other summary.
    textFields: {
      abstract: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      headnote: sourceTextField(ADAPTER_KEYS.PL_NSA, row.thesis),
      legalSentence: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      summary: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    },
    judges: judgesOf(row),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court: court.name,
      courtAsPublished: row.court_name ?? undefined,
      courtStatedBy: court.statedBy,
      courtLevel: court.level,
      courtSeat: court.seat,
      courtBranch: court.branch,
      courtEra: court.era,
      decisionDate,
      decisionType: kind.type,
      decisionForm: row.judgment_type ?? undefined,
      bench: kind.bench,
      documentId: identity.id,
      identityKind: identity.kind,
      docketAsPublished: row.docket_number ?? undefined,
      docketRecognised: docket?.recognised,
      docketRangeMembers: rangeMembers.length === 0 ? undefined : rangeMembers,
      finality: plNsaFinality(row.finality, snapshot.snapshotDate),
      filedDate: warsawDate(row.submission_date),
      judges: row.judges ?? undefined,
      presiding: row.presiding_judge ?? undefined,
      rapporteur: row.judge_rapporteur ?? undefined,
      caseSymbols: row.case_type_description?.map(caseSymbol),
      keywords: row.keywords ?? undefined,
      relatedDecisions: row.related_docket_numbers?.map((related) => {
        const relatedId = plNsaDocumentId(related.judgment_id);
        return {
          documentId: relatedId?.id ?? null,
          caseNumber: normalizeDocket(related.docket_number),
          decisionDate: warsawDate(related.judgment_date) ?? null,
          decisionForm: related.judgment_type,
          sourceUrl:
            relatedId?.portal === true ? plNsaPortalUrl(relatedId.id) : null,
        };
      }),
      challengedAuthority: nonEmpty(row.challenged_authority) ?? undefined,
      outcome: row.decision ?? undefined,
      citedProvisions: row.extracted_legal_bases ?? undefined,
      officialCollection: row.official_collection ?? undefined,
      glossInformation: row.glosa_information ?? undefined,
      textSections: sectionPresence(row),
      textComplete: parsed.validation.ok,
      textSource: parsed.textSource,
      dataset: {
        ...snapshotPart,
        country: row.country,
        courtType: row.court_type,
        source: row.source,
      },
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_NSA],
    documentAst: parsed.documentAst ?? EMPTY_AST,
    sections: parsed.sections,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };

  return { type: "built", decision };
};

// ── Replay ───────────────────────────────────────────────

const snapshotPartSchema = v.object({
  repository: v.string(),
  revision: v.string(),
  snapshotDate: v.string(),
  shard: v.string(),
  row: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const parseJson = (raw: string | undefined): unknown =>
  raw === undefined
    ? null
    : Result.try({
        try: (): unknown => JSON.parse(raw),
        catch: () => null,
      }).unwrapOr(null);

/**
 * Rebuild a decision from its stored envelope. The snapshot part names the
 * revision and position the row was read at, so the replay states the same
 * provenance the import did — against that revision, not the pinned one.
 */
const reparsePlNsaStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.ROW,
    identityOf: (listing) => plNsaIdentityOf(listing).id,
  });
  if (read.type === "rejected") {
    return read;
  }
  const snapshotPart = v.safeParse(
    snapshotPartSchema,
    parseJson(read.parts[RAW_PART.SNAPSHOT]),
  );
  if (!snapshotPart.success) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "the stored envelope names no snapshot position",
    };
  }
  const { repository, revision, row, shard, snapshotDate } =
    snapshotPart.output;
  const built = assemblePlNsaDecision({
    source: read.listing,
    position: {
      shard: PL_NSA_SNAPSHOT.shards.find(({ path }) => path === shard) ?? {
        index: -1,
        path: shard,
        bytes: 0,
        sha256: "",
        rows: 0,
      },
      row,
    },
    snapshot: {
      repository,
      revision,
      snapshotDate,
      shards: PL_NSA_SNAPSHOT.shards,
    },
  });
  return { type: "parsed", result: built.decision };
};

// ── Source-field inventory ───────────────────────────────

const metadataField = (key: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key },
});

const PL_NSA_SOURCE_FIELDS = {
  country: metadataField("dataset"),
  court_type: metadataField("dataset"),
  source: metadataField("dataset"),
  judgment_id: { disposition: "stored", target: { type: "identity" } },
  docket_number: metadataField("docketAsPublished"),
  judgment_type: metadataField("decisionForm"),
  finality: metadataField("finality"),
  judgment_date: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  submission_date: metadataField("filedDate"),
  court_name: metadataField("courtAsPublished"),
  judges: metadataField("judges"),
  presiding_judge: metadataField("presiding"),
  judge_rapporteur: metadataField("rapporteur"),
  case_type_description: metadataField("caseSymbols"),
  keywords: metadataField("keywords"),
  related_docket_numbers: metadataField("relatedDecisions"),
  "related_docket_numbers.judgment_id": metadataField("relatedDecisions"),
  "related_docket_numbers.docket_number": metadataField("relatedDecisions"),
  "related_docket_numbers.judgment_date": metadataField("relatedDecisions"),
  "related_docket_numbers.judgment_type": metadataField("relatedDecisions"),
  challenged_authority: metadataField("challengedAuthority"),
  decision: metadataField("outcome"),
  extracted_legal_bases: metadataField("citedProvisions"),
  "extracted_legal_bases.link": metadataField("citedProvisions"),
  "extracted_legal_bases.article": metadataField("citedProvisions"),
  "extracted_legal_bases.journal": metadataField("citedProvisions"),
  "extracted_legal_bases.law": metadataField("citedProvisions"),
  official_collection: metadataField("officialCollection"),
  glosa_information: metadataField("glossInformation"),
  thesis: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  sentence: { disposition: "stored", target: { type: "document" } },
  reasons_for_judgment: { disposition: "stored", target: { type: "document" } },
  dissenting_opinion: { disposition: "stored", target: { type: "document" } },
  // The dataset's own rendering of the sections under their headings: the
  // text the parsed document is checked against, kept verbatim in the row.
  full_text: { disposition: "stored", target: { type: "document" } },
} as const satisfies Record<SourceField, SourceFieldDisposition>;

/** What the stored row states: its columns and the fields of its lists. */
const listPlNsaSourceFields = (parts: SourceRawParts): readonly string[] => {
  const row = parseJson(parts[RAW_PART.ROW]);
  if (!isRecord(row)) {
    return [];
  }
  const nested = new Set<string>();
  for (const [column, value] of Object.entries(row)) {
    const items: unknown[] = Array.isArray(value) ? value : [];
    for (const item of items) {
      for (const field of isRecord(item) ? Object.keys(item) : []) {
        nested.add(`${column}.${field}`);
      }
    }
  }
  return [...Object.keys(row), ...nested];
};

const SOURCE_SURFACES = ["dataset-row", "court-page"] as const;

const PL_NSA_SOURCE_SURFACES = {
  surfaces: {
    "dataset-row": storedSourceSurface(RAW_PART.ROW),
    "court-page": excludedSourceSurface(
      "the court portal's page for the decision, linked as its source address and never requested by this import",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Cursor ───────────────────────────────────────────────

/** A position in the pinned revision; `shard === shards.length` is the end. */
type PlNsaCursor = { shard: number; row: number };

const CURSOR_PATTERN =
  /^(?<revision>[0-9a-f]{40}):(?<shard>\d{1,4}):(?<row>\d{1,9})$/u;

export const parsePlNsaCursor = (
  cursor: string | null,
  snapshot: PlNsaSnapshot,
): PlNsaCursor => {
  const groups =
    cursor === null ? undefined : CURSOR_PATTERN.exec(cursor)?.groups;
  // A cursor from another revision names positions in files that are not
  // these; the walk starts this revision from its beginning.
  if (groups === undefined || groups["revision"] !== snapshot.revision) {
    return { shard: 0, row: 0 };
  }
  const shard = Math.min(Number(groups["shard"]), snapshot.shards.length);
  return { shard, row: Number(groups["row"]) };
};

export const encodePlNsaCursor = (
  { row, shard }: PlNsaCursor,
  snapshot: PlNsaSnapshot,
): string => `${snapshot.revision}:${shard}:${row}`;

/** The first row at or after `cursor` that exists, or the end. */
const settle = (cursor: PlNsaCursor, snapshot: PlNsaSnapshot): PlNsaCursor => {
  let { row, shard } = cursor;
  while (shard < snapshot.shards.length) {
    const rows = snapshot.shards[shard]?.rows ?? 0;
    if (row < rows) {
      return { shard, row };
    }
    shard += 1;
    row = 0;
  }
  return { shard: snapshot.shards.length, row: 0 };
};

// ── Crawl ────────────────────────────────────────────────

/**
 * Rows read from a shard at a time. Each read copies every column chunk of
 * the shard it touches, so the window is what bounds that cost; the pages
 * handed to the pipeline are cut from it.
 */
const DEFAULT_WINDOW_ROWS = 1000;

/** Decisions per page handed to the pipeline. */
const DEFAULT_PAGE_ROWS = 250;

/** Identities per reconciliation listing page: one narrow column. */
const LISTING_PAGE_ROWS = 10_000;

export type PlNsaCrawlerOptions = {
  snapshot: PlNsaSnapshot;
  source: PlNsaShardSource;
  windowRows?: number | undefined;
  pageRows?: number | undefined;
};

export type PlNsaCrawler = {
  fetchPage: (
    cursor: string | null,
    signal?: AbortSignal,
  ) => Promise<Result<SyncPage, AdapterFetchError>>;
  /** Rejects with the classified failure, as the reconciliation engine reads it. */
  listSlicePage: (
    options: ReconciliationSlicePageOptions,
  ) => Promise<ReconciliationSlicePage>;
  /** Rejects with the classified failure, as the reconciliation engine reads it. */
  buildDecision: (
    payload: unknown,
    signal?: AbortSignal,
  ) => Promise<ReconciliationBuildOutcome>;
};

const listingPayloadSchema = v.object({
  revision: v.string(),
  shard: v.pipe(v.number(), v.integer(), v.minValue(0)),
  row: v.pipe(v.number(), v.integer(), v.minValue(0)),
  identity: v.string(),
});

const sliceName = (index: number): string => String(index).padStart(2, "0");

const sliceIndex = (slice: string): number | null => {
  const index = /^\d{2,4}$/u.test(slice) ? Number(slice) : Number.NaN;
  return Number.isSafeInteger(index) ? index : null;
};

type Window = { shard: number; start: number; rows: PlNsaDatasetRow[] };

export const createPlNsaCrawler = ({
  pageRows = DEFAULT_PAGE_ROWS,
  snapshot,
  source,
  windowRows = DEFAULT_WINDOW_ROWS,
}: PlNsaCrawlerOptions): PlNsaCrawler => {
  let cached: Window | null = null;
  /** The read in flight, so overlapping callers queue behind it. */
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * The rows of the window holding `row`, read once per window. Calls are
   * serialised: the reconciliation engine may build several items at once,
   * and two reads racing for the one shard on disk would download it twice
   * into the same partial file, or evict it while the other reads it.
   */
  const windowAt = async (
    target: PlNsaShard,
    row: number,
    signal?: AbortSignal,
  ): Promise<Result<Window, AdapterFetchError>> => {
    const turn = queue.then(
      async () => await readWindowAt(target, row, signal),
    );
    queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return await turn;
  };

  const readWindowAt = async (
    target: PlNsaShard,
    row: number,
    signal?: AbortSignal,
  ): Promise<Result<Window, AdapterFetchError>> => {
    const start = row - (row % windowRows);
    if (cached?.shard === target.index && cached.start === start) {
      return Result.ok(cached);
    }
    cached = null;
    const file = await source.local(target, signal);
    if (Result.isError(file)) {
      return file;
    }
    const rows = await readPlNsaRows({
      file: file.value,
      expectedRows: target.rows,
      rowStart: start,
      rowEnd: Math.min(start + windowRows, target.rows),
    });
    if (Result.isError(rows)) {
      return rows;
    }
    cached = { shard: target.index, start, rows: rows.value };
    return Result.ok(cached);
  };

  const build = (
    rowSource: PlNsaDatasetRow,
    position: PlNsaPosition,
  ): IngestionResult =>
    assemblePlNsaDecision({ source: rowSource, position, snapshot }).decision;

  const fetchPage = async (
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Result<SyncPage, AdapterFetchError>> => {
    const at = settle(parsePlNsaCursor(cursor, snapshot), snapshot);
    const target = snapshot.shards[at.shard];
    if (target === undefined) {
      // Past the last shard: the pinned revision has nothing left, and the
      // cursor parks here without asking for anything (rule 13).
      return Result.ok({
        decisions: [],
        nextCursor: encodePlNsaCursor(at, snapshot),
      });
    }

    const window = await windowAt(target, at.row, signal);
    if (Result.isError(window)) {
      return window;
    }
    const { rows, start } = window.value;
    const from = at.row - start;
    const taken = rows.slice(from, from + pageRows);
    // The footer and every column were held to the pinned count, so a row
    // the cursor names is a row the window holds.
    if (taken.length === 0) {
      return panic(`${target.path} holds no row ${at.row}`);
    }
    const decisions = taken.map((rowSource, offset) =>
      build(rowSource, { shard: target, row: at.row + offset }),
    );
    const next = settle(
      { shard: at.shard, row: at.row + taken.length },
      snapshot,
    );
    return Result.ok({
      decisions,
      sourceUrl: plNsaShardUrl(snapshot, target),
      nextCursor: encodePlNsaCursor(next, snapshot),
    });
  };

  const listSlicePage = async ({
    page,
    signal,
    slice,
  }: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
    const index = sliceIndex(slice);
    const target = index === null ? undefined : snapshot.shards[index];
    if (target === undefined) {
      return { items: [], totalPages: 0 };
    }
    const totalPages = Math.ceil(target.rows / LISTING_PAGE_ROWS);
    const rowStart = page * LISTING_PAGE_ROWS;
    if (rowStart >= target.rows) {
      return { items: [], totalPages };
    }
    const file = await source.remote(target, signal);
    const listed = Result.isError(file)
      ? file
      : await readPlNsaListing({
          file: file.value,
          expectedRows: target.rows,
          rowStart,
          rowEnd: Math.min(rowStart + LISTING_PAGE_ROWS, target.rows),
        });
    if (Result.isError(listed)) {
      // The engine holds the slice's previous ledger row on a rejection; a
      // failure returned as a page would settle the slice over the outage.
      return await Promise.reject(listed.error);
    }
    return {
      items: listed.value.map(({ fingerprint, judgmentId }, offset) => {
        const identity = plNsaIdentityOf(
          fingerprint ?? { judgment_id: judgmentId },
        ).id;
        return {
          identity: { type: "document", sourceDocumentId: identity },
          payload: {
            revision: snapshot.revision,
            shard: target.index,
            row: rowStart + offset,
            identity,
          },
        };
      }),
      totalPages,
    };
  };

  const buildDecision = async (
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ReconciliationBuildOutcome> => {
    const parsed = v.safeParse(listingPayloadSchema, payload);
    const target = parsed.success
      ? snapshot.shards[parsed.output.shard]
      : undefined;
    if (
      !parsed.success ||
      target === undefined ||
      parsed.output.revision !== snapshot.revision
    ) {
      return { type: "unkeyable" };
    }
    const { identity, row } = parsed.output;
    // The engine bounds each item with this signal; a shard download it
    // triggers has to stop with it, not run on past the item's timeout.
    const window = await windowAt(target, row, signal);
    if (Result.isError(window)) {
      return await Promise.reject(window.error);
    }
    const rowSource = window.value.rows[row - window.value.start];
    // The position was listed from this revision, so the row there is the one
    // listed; a different identity means the listing and the file disagree.
    if (rowSource === undefined || plNsaIdentityOf(rowSource).id !== identity) {
      return { type: "detail-unavailable" };
    }
    return {
      type: "built",
      decision: build(rowSource, { shard: target, row }),
    };
  };

  return { fetchPage, listSlicePage, buildDecision };
};

// ── Adapter ──────────────────────────────────────────────

/** One crawler per cache directory, so its window survives between pages. */
const crawlers = new Map<string, PlNsaCrawler>();

const productionCrawler = (config: Record<string, unknown>): PlNsaCrawler => {
  const cacheDirectory =
    typeof config["cacheDirectory"] === "string"
      ? config["cacheDirectory"]
      : undefined;
  const key = cacheDirectory ?? "";
  const existing = crawlers.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const crawler = createPlNsaCrawler({
    snapshot: PL_NSA_SNAPSHOT,
    source: huggingFaceShardSource({
      snapshot: PL_NSA_SNAPSHOT,
      cacheDirectory,
    }),
  });
  crawlers.set(key, crawler);
  return crawler;
};

const lastSlice = sliceName(PL_NSA_SNAPSHOT.shards.length - 1);

export const plNsaAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_NSA,
  language: PL_NSA_LANGUAGE,
  minRequestIntervalMs: publisherRequestIntervalMs(ADAPTER_KEYS.PL_NSA),
  // The first page of a shard downloads it: about 700 MB in a dozen ranged
  // requests, checked against its digest before a row is read.
  pageTimeoutMs: 20 * 60 * 1000,
  maxCycleMs: 40 * 60 * 1000,
  maxSyncPages: 40,

  reparseStoredRaw: reparsePlNsaStoredRaw,

  sourceSurfaces: PL_NSA_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: PL_NSA_SOURCE_FIELDS,
    listSourceFields: listPlNsaSourceFields,
  },

  /** Every shard's footer states its rows; the pinned revision is their sum. */
  async getTotalCount(_signal) {
    return await Promise.resolve({
      type: "count",
      total: plNsaSnapshotRows(PL_NSA_SNAPSHOT),
    });
  },

  reconciliation: {
    firstSlice: sliceName(0),
    // A snapshot has no present: its newest slice is its last shard.
    sliceOf: () => lastSlice,
    nextSlice: (slice) => {
      const index = sliceIndex(slice);
      return index === null || index + 1 >= PL_NSA_SNAPSHOT.shards.length
        ? null
        : sliceName(index + 1);
    },
    previousSlice: (slice) => {
      const index = sliceIndex(slice);
      return index === null || index <= 0 ? null : sliceName(index - 1);
    },
    tipWindowDays: 1,
    listSlicePage: async (options) =>
      await productionCrawler({}).listSlicePage(options),
    buildDecision: async (payload, signal) =>
      await productionCrawler({}).buildDecision(payload, signal),
  },

  /**
   * The walk's own failures come back as `Err`; this wrapper is for what the
   * reader or the fetch layer raises instead — a cycle abort above all.
   */
  async fetchPage(cursor, config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () =>
          await productionCrawler(config).fetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_NSA, cursor),
      }),
    );
  },
});
