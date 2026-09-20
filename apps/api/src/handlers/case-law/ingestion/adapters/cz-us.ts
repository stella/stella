import { Result, panic } from "better-result";
import * as cheerio from "cheerio";

import { Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  decodeSourceRawEnvelope,
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  fetchNalus,
  NALUS_REQUEST_INTERVAL_MS,
  NalusRateLimitedError,
  type NalusRequestInit,
} from "@/api/handlers/case-law/ingestion/adapters/cz-us-throttle";
import {
  adapterCatch,
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseUsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-us";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { stripAcademicTitles } from "@/api/handlers/case-law/judges/judge-name";
import { czDecisionCourt } from "@/api/lib/case-law/cz-ecli-courts";
import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
  absentDecisionTextFields,
  absentTextField,
  checkedDecisionMetadata,
  sourceTextField,
  type DecisionTextFields,
  type TextField,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { DecisionJudgeInput } from "@/api/lib/legal-search/ingestion-types";
import { logger } from "@/api/lib/observability/logger";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/**
 * Czech Constitutional Court (Ústavní soud) adapter.
 *
 * Scrapes the NALUS database at nalus.usoud.cz through its public search UI.
 * NALUS has no JSON API, but its WebForms search is a complete, paginated
 * enumeration surface. Each result carries the court's exact GetText.aspx
 * identifier and its internal record id. The record id is the canonical
 * document identity; the text identifier is an optional retrieval action.
 *
 * Never reconstruct a GetText identifier from a docket. Historical NALUS
 * identifiers use a different grammar, chamber numbering was not globally
 * sequential, plenary dockets overlap chamber numbers, and one docket can
 * publish several decisions. Probing `I-{number}-{year}_1` loses all of those
 * distinctions.
 *
 * Every request to the court goes through the publisher gate in
 * `cz-us-throttle.ts`: NALUS states a 5,000-requests-a-day ceiling for
 * automated clients and redirects a client past it to a limit page, so the
 * budget is a structural property of this adapter rather than a habit of its
 * loops.
 *
 * Cursor formats:
 *   search:historical:<available-to>:<decision-year>:<pass>:<page>:<digest>:<expected>
 *   search:recent-frontier:<verified-through>:<available-to>:<pass>:<page>:<digest>:<expected>
 *
 * A null or legacy probe cursor starts the search-based historical repair at
 * FIRST_YEAR. This intentionally re-enumerates history once: it migrates the
 * incomplete probe crawl onto publisher-stated document identities.
 *
 * The recent phase is a frontier, not a rolling window: it lists the
 * availability days after the last closed day it verified and then stands
 * still, so a day on which the court publishes nothing costs no request at
 * all. Whether a decision year is complete is the reconciliation ledger's
 * question, not this cursor's.
 *
 * The same search form takes an arbitrary decision-date range, which is what
 * makes this source reconcilable: a decision year can be listed on its own,
 * without the crawl cursor ever reaching it. See `reconciliation` at the
 * bottom of this file.
 */

const ABSTRACT_URL = "https://nalus.usoud.cz/Search/GetAbstract.aspx";
const RESULT_DETAIL_URL = "https://nalus.usoud.cz/Search/ResultDetail.aspx";
const SEARCH_URL = "https://nalus.usoud.cz/Search/Search.aspx";
const RESULTS_URL = "https://nalus.usoud.cz/Search/Results.aspx";
const TEXT_URL = "https://nalus.usoud.cz/Search/GetText.aspx";

/**
 * The court a NALUS decision is stored under when nothing about it names one.
 *
 * A publisher is not a court, so this is the fallback and not the label: the
 * deciding court is read off the decision's own ECLI through
 * {@link czDecisionCourt}, which is what keeps a record NALUS republishes
 * from another court out of the Constitutional Court's shelf and out of its
 * authority tier.
 */
const CZ_US_PUBLISHER_COURT = "Ústavní soud";

const persistableNalusComponent = (
  namespace: "nalus-record" | "nalus-sz" | "nalus-ecli",
  value: string | undefined,
): string | undefined =>
  value !== undefined &&
  value.length > 0 &&
  isPersistableSourceDocumentId(`${namespace}:${value}`)
    ? value
    : undefined;

const nalusIdentities = ({
  recordId,
  sz,
  ecli,
}: {
  recordId: string | undefined;
  sz: string | undefined;
  ecli: string | undefined;
}): {
  sourceDocumentId: string;
  aliases: readonly string[] | undefined;
} | null => {
  const identities = [
    recordId ? `nalus-record:${recordId}` : undefined,
    sz ? `nalus-sz:${sz}` : undefined,
    ecli ? `nalus-ecli:${ecli}` : undefined,
  ].filter(
    (identity): identity is string =>
      identity !== undefined && isPersistableSourceDocumentId(identity),
  );
  const sourceDocumentId = identities.at(0);
  if (sourceDocumentId === undefined) {
    return null;
  }
  const aliases = identities.slice(1);
  return {
    sourceDocumentId,
    aliases: aliases.length === 0 ? undefined : aliases,
  };
};

/**
 * Rows per crawl page.
 *
 * Sized against the gate rather than the court: every row costs a text, a
 * record-card and an abstract request, each of which waits its NALUS slot, so
 * the page size is what decides a page's wall clock. See
 * {@link CZ_US_PAGE_TIMEOUT_MS}.
 */
export const RESULTS_PAGE_SIZE = 12;

/** Search requests one result page costs: bootstrap GET, POST, results page. */
const REQUESTS_PER_LISTING = 3;

/** Requests one kept row costs: GetText, then ResultDetail and GetAbstract. */
const REQUESTS_PER_DECISION = 3;

const PAGE_REQUEST_BUDGET =
  REQUESTS_PER_LISTING + RESULTS_PAGE_SIZE * REQUESTS_PER_DECISION;

/**
 * How long one crawl page may take, derived from what the gate makes it cost
 * so the two cannot drift apart.
 *
 * The runner exits a cycle that outlives 45 minutes, and the pipeline checks
 * `maxCycleMs` only between pages, so a page may start just under
 * {@link CZ_US_MAX_CYCLE_MS} and still has to finish inside that ceiling.
 */
const CZ_US_PAGE_TIMEOUT_MS =
  PAGE_REQUEST_BUDGET * (NALUS_REQUEST_INTERVAL_MS + ADAPTER_TIMEOUT.REQUEST);

const CZ_US_MAX_CYCLE_MS = 30 * 60 * 1000;

/**
 * Result size for a listing walk, the largest the search form offers. The
 * crawl takes forty at a time because every row it keeps costs a text and an
 * abstract fetch; a listing walk fetches no documents, so it asks for the whole
 * eighty. NALUS honours it: a 2013 query answers `Výsledky 1 - 80 z celkem
 * 4345`, and `?page=1` answers `81 - 160`.
 */
const LISTING_PAGE_SIZE = 80;

/** Detail/abstract pairs fetched concurrently from the court. */
const DOCUMENT_CONCURRENCY = 5;

/** First year of the Constitutional Court's existence. */
const FIRST_YEAR = Number.parseInt(
  ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_US].dateRange.fromInclusive.slice(0, 4),
  10,
);

const SWEEP_PHASE = {
  /** One-time complete enumeration by decision year. */
  HISTORICAL: "historical",
  /** Steady state: enumerate the source's recent publication window. */
  RECENT: "recent",
} as const;

const CRAWL_PASS = {
  COLLECT: "collect",
  VERIFY: "verify",
} as const;

type CrawlPass = (typeof CRAWL_PASS)[keyof typeof CRAWL_PASS];

/** Seed for the rolling identity digest stored in the cursor. */
const DIGEST_SEED = "0";

const NO_RESULTS_MESSAGE = "Pro zadaná kritéria nebyly nalezeny žádné záznamy.";

const REGISTRY_SIGN_PATTERN =
  /^(?<caseNumber>\S+(?:\s\S+)*?)\s+ze\s+dne\s+(?<date>\S.*)$/u;
const DOC_CONTENT_PATTERN = /class="DocContent">(?<body>[\s\S]*?)<\/table>/u;

/** Extract text from a labeled span. */
const extractLabel = (html: string, labelId: string): string | undefined => {
  const pattern = new RegExp(`id="${labelId}"[^>]*>([\\s\\S]*?)</span>`, "iu");
  const match = html.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  return stripHtml(match[1]).trim() || undefined;
};

/**
 * Roman numeral senate prefix → number for ECLI.
 * Pl (Plenary) is not mapped here; it is normalized
 * to uppercase "PL" in buildEcli via explicit handling.
 */
const SENATE_MAP: Record<string, string> = {
  I: "1",
  II: "2",
  III: "3",
  IV: "4",
};

const parseCaseNumberComponents = (
  caseNumber: string,
): { senate: string; caseIndex: string; shortYear: string } | undefined => {
  const { senate, caseIndex, shortYear } =
    /^(?<senate>[IVX]+|Pl)\.ÚS\s+(?<caseIndex>\d+)\/(?<shortYear>\d+)$/u.exec(
      caseNumber,
    )?.groups ?? {};
  return senate && caseIndex && shortYear
    ? { senate, caseIndex, shortYear }
    : undefined;
};

/**
 * Build ECLI from parsed case number components.
 *
 * Format: ECLI:CZ:US:{year}:{senate}.US.{index}.{shortYear}.{counter}
 * Example: II.ÚS 3436/14 #1, year 2016 → ECLI:CZ:US:2016:2.US.3436.14.1
 *
 * The counter comes from the registry sign (`#1`), not hardcoded.
 * Returns undefined if any component can't be parsed.
 */
const buildEcli = (
  caseNumber: string,
  decisionYear: number,
  counter: number,
): string | undefined => {
  // "II.ÚS 3436/14" or "Pl.ÚS 24/10"
  const components = parseCaseNumberComponents(caseNumber);
  if (!components) {
    return undefined;
  }
  const { senate, caseIndex, shortYear } = components;
  const mappedSenate = SENATE_MAP[senate] ?? senate.toUpperCase();
  return `ECLI:CZ:US:${decisionYear}:${mappedSenate}.US.${caseIndex}.${shortYear}.${counter}`;
};

const parseCounter = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const counter = Number.parseInt(raw, 10);
  return Number.isSafeInteger(counter) && counter > 0 ? counter : undefined;
};

/** Extract case number and date from the registry sign label. */
const parseRegistrySign = (
  raw: string,
): {
  caseNumber: string;
  decisionDate?: string | undefined;
} | null => {
  // Format: "Pl.ÚS 24/10 ze dne 22. 3. 2011" (visible label, no counter)
  const { caseNumber, date } = REGISTRY_SIGN_PATTERN.exec(raw)?.groups ?? {};
  if (!caseNumber || !date) {
    return null;
  }

  return {
    caseNumber: caseNumber.trim(),
    decisionDate: parseCeDate(date),
  };
};

/**
 * Extract ECLI counter from the hidden registry sign field.
 *
 * The visible lblRegistrySign omits the counter, but
 * registrySignHidden includes it: "I.ÚS 100/25 #1 ze dne ...".
 * Returns undefined if the counter is not present.
 */
const extractEcliCounter = (html: string): number | undefined => {
  const hidden = /name="registrySignHidden"[^>]*value="(?<value>[^"]*)"/u.exec(
    html,
  );
  const hiddenValue = hidden?.groups?.["value"];
  if (!hiddenValue) {
    return undefined;
  }
  const counter = /#(?<counter>\d+)/u.exec(hiddenValue)?.groups?.["counter"];
  return parseCounter(counter);
};

/** URL identity emitted by the pre-search adapter for counter-one records. */
const legacySourceUrlsFor = (
  caseNumber: string,
  counter: number | undefined,
  nalusSz: string | undefined,
): readonly string[] | undefined => {
  if (counter !== 1) {
    return undefined;
  }
  const components = parseCaseNumberComponents(caseNumber);
  if (!components) {
    return undefined;
  }
  const legacyYear = String(
    Number.parseInt(components.shortYear, 10) % 100,
  ).padStart(2, "0");
  const legacySz = `I-${components.caseIndex}-${legacyYear}_1`;
  // The old probe always requested an I-prefixed URL, but NALUS can map
  // that guessed URL to a different chamber/plenary docket with the same
  // visible number. It is an adoption alias only when the listing exposes
  // that exact retrieval identity for this exact publisher record.
  if (nalusSz !== legacySz) {
    return undefined;
  }
  return [`https://nalus.usoud.cz/Search/GetText.aspx?sz=${legacySz}`];
};

/** Plain text of the DocContent table, the decision body. */
const extractDocContentText = (html: string): string | undefined => {
  const body = DOC_CONTENT_PATTERN.exec(html)?.groups?.["body"];
  if (!body) {
    return undefined;
  }

  return stripHtml(body);
};

/** Extract fulltext body from DocContent table. */
const extractFulltext = (bodyText: string | undefined): string | undefined =>
  bodyText !== undefined && bodyText.length > 50 ? bodyText : undefined;

/** Below this a cell holds a stub or a label, not a publisher's own text. */
const ABSTRACT_MIN_CHARS = 20;

const fieldAboveAbstractMinimum = (field: TextField): TextField => {
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return field;
    case TEXT_FIELD_TYPE.PRESENT:
      return field.text.length >= ABSTRACT_MIN_CHARS
        ? field
        : absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED);
    default: {
      field satisfies never;
      return panic(`Unhandled decision text field: ${String(field)}`);
    }
  }
};

/**
 * Project one publisher cell to text without erasing its block breaks. NALUS
 * separates abstract paragraphs and headings with paired `<br>` elements;
 * Cheerio's `.text()` drops both and welds the blocks together.
 */
const supplementText = ($: cheerio.CheerioAPI, selector: string): string => {
  const cells: string[] = [];
  $(selector).each((_, element) => {
    const cell = $(element).clone();
    cell.find("br").replaceWith("\n");
    const text = cell
      .text()
      .replaceAll(/\r\n?/gu, "\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replaceAll(/\n{3,}/gu, "\n\n")
      .trim();
    if (text !== "") {
      cells.push(text);
    }
  });
  return cells.join("\n\n");
};

/**
 * Extract abstract and legal sentence from GetAbstract.aspx.
 *
 * Both source cells are represented by the text-field contract.
 */
const extractAbstract = (
  html: string,
): Required<Pick<DecisionTextFields, "abstract" | "legalSentence">> => {
  const $ = cheerio.load(html);
  return {
    abstract: fieldAboveAbstractMinimum(
      sourceTextField(
        ADAPTER_KEYS.CZ_US,
        supplementText($, "table.abstractContent td"),
      ),
    ),
    legalSentence: fieldAboveAbstractMinimum(
      sourceTextField(
        ADAPTER_KEYS.CZ_US,
        supplementText($, "table.legalSentenceContent td"),
      ),
    ),
  };
};

// ── Record card (ResultDetail.aspx) ──────────────────────

/**
 * What the court answered about a row's record card, stated on the row itself.
 *
 * Selectable, because it is what the judges backfill walks: a row stored
 * before this adapter read the card carries no value at all, `absent` is the
 * court's own durable answer and leaves the selection for good, and
 * `unavailable` says nothing about the row, so a later run asks again.
 */
export const CZ_US_RECORD_CARD_METADATA_KEY = "recordCard";

export const CZ_US_RECORD_CARD_STATE = {
  READ: "read",
  ABSENT: "absent",
  UNAVAILABLE: "unavailable",
} as const;

export type CzUsRecordCardState =
  (typeof CZ_US_RECORD_CARD_STATE)[keyof typeof CZ_US_RECORD_CARD_STATE];

/**
 * The labels NALUS prints on a decision's record card, each mapped to the
 * name this adapter reads it under.
 *
 * This map is the source-field inventory's field list as well: the
 * disposition map below is keyed on `keyof typeof NALUS_DETAIL_LABELS`, so a
 * label added here without a decision does not compile, and a label the court
 * adds to the page reaches `listSourceFields` as an undeclared field rather
 * than as silence.
 */
const NALUS_DETAIL_LABELS = {
  "Identifikátor evropské judikatury": "ecli",
  "Název soudu": "courtName",
  "Spisová značka": "caseNumber",
  "Paralelní citace (Sbírka zákonů)": "parallelCitationLaws",
  "Paralelní citace (Sbírka nálezů a usnesení)": "parallelCitationReports",
  "Populární název": "popularName",
  "Datum rozhodnutí": "decisionDate",
  "Datum vyhlášení": "announcedOn",
  "Datum podání": "filedOn",
  "Datum zpřístupnění": "availableFrom",
  "Forma rozhodnutí": "decisionForm",
  "Typ řízení": "proceedingType",
  Význam: "significance",
  Navrhovatel: "petitioner",
  "Dotčený orgán": "affectedAuthority",
  "Soudce zpravodaj": "rapporteur",
  "Napadený akt": "challengedAct",
  "Typ výroku": "rulingType",
  "Dotčené ústavní zákony a mezinárodní smlouvy": "constitutionalProvisions",
  "Ostatní dotčené předpisy": "otherProvisions",
  "Odlišné stanovisko": "dissentingJudges",
  "Předmět řízení": "proceedingSubject",
  "Věcný rejstřík": "subjectIndex",
  "Jazyk rozhodnutí": "decisionLanguage",
  Poznámka: "note",
  "URL adresa": "documentUrl",
} as const;

type NalusDetailLabel = keyof typeof NALUS_DETAIL_LABELS;

export type NalusDetailFieldKey =
  (typeof NALUS_DETAIL_LABELS)[NalusDetailLabel];

/**
 * One decision's record card, read.
 *
 * Every field is a list because the court separates repeats inside one cell
 * with `<br/>`, and it does so for more cells than a reader would guess: a
 * plenary decision has one rapporteur and nine dissenters, three petitioners
 * and two verdict types. A field the court leaves blank is an empty list, so
 * the record is total and absence reads the same way everywhere.
 */
export type NalusDetailFields = Readonly<
  Record<NalusDetailFieldKey, readonly string[]>
>;

const DETAIL_FIELD_BY_LABEL = new Map<string, NalusDetailFieldKey>(
  Object.entries(NALUS_DETAIL_LABELS),
);

/**
 * The record card's own table. Scoped rather than matched by label text: the
 * page repeats `Soudce zpravodaj` as a column heading of the result row above
 * the card, where it labels nothing.
 */
const RECORD_CARD_SELECTOR = "table.recordCardTable tr";

/** Repeats inside one value cell, as the court separates them. */
const DETAIL_VALUE_SEPARATOR = /<br\s*\/?>/giu;

const detailText = (text: string): string =>
  text.replaceAll(" ", " ").replace(/\s+/gu, " ").trim();

/**
 * A field per label, all empty.
 *
 * Written out rather than derived from the label map, because the compiler
 * then holds the two to exact agreement: a field added to the map and missed
 * here does not compile, and neither does one left behind here.
 */
const emptyDetailFields = (): Record<NalusDetailFieldKey, string[]> => ({
  ecli: [],
  courtName: [],
  caseNumber: [],
  parallelCitationLaws: [],
  parallelCitationReports: [],
  popularName: [],
  decisionDate: [],
  announcedOn: [],
  filedOn: [],
  availableFrom: [],
  decisionForm: [],
  proceedingType: [],
  significance: [],
  petitioner: [],
  affectedAuthority: [],
  rapporteur: [],
  challengedAct: [],
  rulingType: [],
  constitutionalProvisions: [],
  otherProvisions: [],
  dissentingJudges: [],
  proceedingSubject: [],
  subjectIndex: [],
  decisionLanguage: [],
  note: [],
  documentUrl: [],
});

/**
 * Read the record card of a NALUS detail page.
 *
 * `null` when the page holds no record card at all, which is what a session
 * bounce answers with: a card read as empty would otherwise be
 * indistinguishable from a decision the court states nothing about.
 */
export const parseNalusDetail = (html: string): NalusDetailFields | null => {
  const $ = cheerio.load(html);
  const rows = $(RECORD_CARD_SELECTOR);
  if (rows.length === 0) {
    return null;
  }
  const fields = emptyDetailFields();
  rows.each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length !== 2) {
      return;
    }
    const key = DETAIL_FIELD_BY_LABEL.get(detailText(cells.eq(0).text()));
    if (key === undefined) {
      return;
    }
    fields[key].push(
      ...(cells.eq(1).html() ?? "")
        .split(DETAIL_VALUE_SEPARATOR)
        .map((part) => detailText(stripHtml(part)))
        .filter((part) => part.length > 0),
    );
  });
  return fields;
};

/**
 * Every label the record card prints, whether or not the court filled it.
 *
 * The card is one part of the envelope, and the only part with labelled
 * fields: the listing row, the document and the abstract this court serves
 * beside it are prose and markup, so reading the card reads everything this
 * source states as a field.
 */
const listNalusSourceFields = (parts: SourceRawParts): readonly string[] => {
  const recordCard = parts["detail"];
  if (recordCard === undefined) {
    return [];
  }
  const $ = cheerio.load(recordCard);
  const labels: string[] = [];
  $(RECORD_CARD_SELECTOR).each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length === 2) {
      labels.push(detailText(cells.eq(0).text()));
    }
  });
  return labels;
};

/**
 * The judges the record card names, rapporteur first and dissenters in the
 * order the court prints them.
 *
 * Titles are stripped here because the printed name is what a reader sees and
 * what the roster is matched on: honorifics differ between the court's own
 * pages and change over a career.
 */
const detailJudges = (fields: NalusDetailFields): DecisionJudgeInput[] =>
  [
    ...fields.rapporteur.map((name) => ({
      role: DECISION_JUDGE_ROLE.RAPPORTEUR,
      nameAsPrinted: stripAcademicTitles(name),
    })),
    ...fields.dissentingJudges.map((name) => ({
      role: DECISION_JUDGE_ROLE.DISSENTING,
      nameAsPrinted: stripAcademicTitles(name),
    })),
  ].filter(({ nameAsPrinted }) => nameAsPrinted.length > 0);

/** Record-card fields the row carries under their own metadata keys. */
const DETAIL_METADATA_KEYS = [
  "parallelCitationLaws",
  "parallelCitationReports",
  "announcedOn",
  "filedOn",
  "availableFrom",
  "proceedingType",
  "significance",
  "petitioner",
  "affectedAuthority",
  "challengedAct",
  "rulingType",
  "constitutionalProvisions",
  "otherProvisions",
  "proceedingSubject",
  "subjectIndex",
  "decisionLanguage",
  "note",
] as const satisfies readonly NalusDetailFieldKey[];

/**
 * The record card as metadata.
 *
 * A cell the court filled once is stored as that string and a repeating one
 * as the list, so a consumer never has to know which cells this court happens
 * to repeat. A blank cell is omitted: the row then says nothing about the
 * field, rather than saying the court states nothing.
 */
const detailMetadata = (
  fields: NalusDetailFields,
): Record<string, string | readonly string[]> =>
  Object.fromEntries(
    DETAIL_METADATA_KEYS.flatMap((key) => {
      const values = fields[key];
      const single = values.at(0);
      if (values.length === 0 || single === undefined) {
        return [];
      }
      return [[key, values.length === 1 ? single : values] as const];
    }),
  );

/**
 * What this source states about a decision, and what becomes of it.
 *
 * Keyed on the record card's labels, so the map is total over the page by
 * construction. `Soudce zpravodaj` and `Odlišné stanovisko` share a target:
 * they are the two roles of one list, which is why the result carries
 * `judges` rather than a field per role.
 */
const NALUS_SOURCE_FIELDS = {
  "Identifikátor evropské judikatury": {
    disposition: "stored",
    target: { type: "result", key: "ecli" },
  },
  "Název soudu": excludedSourceField(
    "the publisher naming itself; the deciding court is resolved from the record's own ECLI, because this database also republishes other courts' decisions",
  ),
  "Spisová značka": {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  "Paralelní citace (Sbírka zákonů)": {
    disposition: "stored",
    target: { type: "metadata", key: "parallelCitationLaws" },
  },
  "Paralelní citace (Sbírka nálezů a usnesení)": {
    disposition: "stored",
    target: { type: "metadata", key: "parallelCitationReports" },
  },
  "Populární název": {
    disposition: "stored",
    target: { type: "metadata", key: "popularName" },
  },
  "Datum rozhodnutí": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  "Datum vyhlášení": {
    disposition: "stored",
    target: { type: "metadata", key: "announcedOn" },
  },
  "Datum podání": {
    disposition: "stored",
    target: { type: "metadata", key: "filedOn" },
  },
  "Datum zpřístupnění": {
    disposition: "stored",
    target: { type: "metadata", key: "availableFrom" },
  },
  "Forma rozhodnutí": {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  "Typ řízení": {
    disposition: "stored",
    target: { type: "metadata", key: "proceedingType" },
  },
  Význam: {
    disposition: "stored",
    target: { type: "metadata", key: "significance" },
  },
  Navrhovatel: {
    disposition: "stored",
    target: { type: "metadata", key: "petitioner" },
  },
  "Dotčený orgán": {
    disposition: "stored",
    target: { type: "metadata", key: "affectedAuthority" },
  },
  "Soudce zpravodaj": {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  "Napadený akt": {
    disposition: "stored",
    target: { type: "metadata", key: "challengedAct" },
  },
  "Typ výroku": {
    disposition: "stored",
    target: { type: "metadata", key: "rulingType" },
  },
  "Dotčené ústavní zákony a mezinárodní smlouvy": {
    disposition: "stored",
    target: { type: "metadata", key: "constitutionalProvisions" },
  },
  "Ostatní dotčené předpisy": {
    disposition: "stored",
    target: { type: "metadata", key: "otherProvisions" },
  },
  "Odlišné stanovisko": {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  "Předmět řízení": {
    disposition: "stored",
    target: { type: "metadata", key: "proceedingSubject" },
  },
  "Věcný rejstřík": {
    disposition: "stored",
    target: { type: "metadata", key: "subjectIndex" },
  },
  "Jazyk rozhodnutí": {
    disposition: "stored",
    target: { type: "metadata", key: "decisionLanguage" },
  },
  Poznámka: {
    disposition: "stored",
    target: { type: "metadata", key: "note" },
  },
  "URL adresa": excludedSourceField(
    "the retrieval address of the document the row already stores as sourceUrl",
  ),
} as const satisfies Record<NalusDetailLabel, SourceFieldDisposition>;

/**
 * The record card as it reached the build.
 *
 * The parsed fields belong to the `read` branch alone, so a state that says
 * the court served no card cannot carry fields and a state that says it did
 * cannot be missing them. Any other state leaves the card's fields absent,
 * never guessed back out of the document's prose.
 */
type ParsedRecordCard =
  | {
      state: typeof CZ_US_RECORD_CARD_STATE.READ;
      fields: NalusDetailFields;
    }
  | {
      state: Exclude<CzUsRecordCardState, typeof CZ_US_RECORD_CARD_STATE.READ>;
    };

type ParseDecisionPageOptions = {
  html: string;
  recordCard: ParsedRecordCard;
  sourceUrl: string;
  sourceDocumentId: string;
  listedEcli: string | undefined;
  listedCounter: number | undefined;
  nalusRecordId: string | undefined;
  nalusSz: string | undefined;
  nalusQuarantineIds: readonly string[];
};

const parseDecisionPage = ({
  html,
  recordCard,
  sourceUrl,
  sourceDocumentId,
  listedEcli,
  listedCounter,
  nalusRecordId,
  nalusSz,
  nalusQuarantineIds,
}: ParseDecisionPageOptions): IngestionResult | null => {
  const registrySign = extractLabel(html, "lblRegistrySign");
  if (!registrySign?.includes("ze dne")) {
    return null; // Empty page
  }

  const detail =
    recordCard.state === CZ_US_RECORD_CARD_STATE.READ
      ? recordCard.fields
      : null;

  const parsed = parseRegistrySign(registrySign);
  if (!parsed) {
    return null;
  }

  const decisionForm =
    extractLabel(html, "lblDecisionForm") ?? detail?.decisionForm.at(0);
  const parallelQuotation = extractLabel(html, "lblParallelQuotation");
  const popularName =
    extractLabel(html, "lblPopularName") ?? detail?.popularName.at(0);
  const bodyText = extractDocContentText(html);
  const fulltext = extractFulltext(bodyText);
  const judges = detail === null ? undefined : detailJudges(detail);
  // The stored facts row reads one name; the roles live on `judges`, and
  // both spell it the way the roster is matched on.
  const judge = judges?.find(
    ({ role }) => role === DECISION_JUDGE_ROLE.RAPPORTEUR,
  )?.nameAsPrinted;

  // Build ECLI from case number + decision year + counter.
  // Counter comes from registrySignHidden (not the visible label).
  // ECLI is only built when both decision year and counter are known.
  const decisionYear = parsed.decisionDate
    ? Number.parseInt(parsed.decisionDate.slice(0, 4), 10)
    : undefined;
  const ecliCounter = extractEcliCounter(html) ?? listedCounter;
  const ecli =
    listedEcli ??
    (decisionYear !== undefined && ecliCounter !== undefined
      ? buildEcli(parsed.caseNumber, decisionYear, ecliCounter)
      : undefined);

  // The court NALUS states for this decision, read off the identifier NALUS
  // itself published. Not `ecli`: `buildEcli` reconstructs an identifier
  // carrying this adapter's own court code, so a court read back from it
  // would be the constant this call exists to remove.
  const court = czDecisionCourt({
    adapterKey: ADAPTER_KEYS.CZ_US,
    ecli: listedEcli,
    publisherCourt: CZ_US_PUBLISHER_COURT,
    sourceDocumentId,
  });

  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let resolvedFulltext = fulltext;

  try {
    const parserResult = parseUsDecisionHtml({
      html,
      caseNumber: parsed.caseNumber,
      ecli,
      court,
      decisionDate: parsed.decisionDate,
      decisionType: decisionForm?.toLowerCase(),
    });
    documentAst = parserResult.documentAst;
    resolvedFulltext = parserResult.fulltext;
  } catch {
    // Parser failed; fall back to empty AST and
    // stripHtml-based fulltext extraction.
  }

  // Hash on identity fields only (not fulltext) for stability
  // across parser changes. Matches NSS adapter pattern.
  const raw = `${sourceDocumentId}|${parsed.caseNumber}|${parsed.decisionDate ?? ""}`;

  return {
    caseNumber: parsed.caseNumber,
    sourceDocumentId,
    sourceDocumentIdAliases: nalusIdentities({
      recordId: nalusRecordId,
      sz: nalusSz,
      ecli,
    })?.aliases,
    sourceDocumentIdRepairAliases: nalusQuarantineIds.map(
      (quarantineId) => `nalus-quarantine:${quarantineId}`,
    ),
    legacySourceUrls: legacySourceUrlsFor(
      parsed.caseNumber,
      ecliCounter,
      nalusSz,
    ),
    ecli,
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_US].country,
    language: "cs",
    decisionDate: parsed.decisionDate,
    decisionType: decisionForm?.toLowerCase(),
    fulltext: resolvedFulltext,
    sourceUrl,
    // Carried whenever the card was read, empty list included: a card whose
    // rapporteur cell the court has blanked states that the decision has no
    // judge on it, and dropping the field would leave the stored rows alone.
    ...(judges === undefined ? {} : { judges }),
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      caseNumber: parsed.caseNumber,
      ecli,
      court,
      decisionDate: parsed.decisionDate,
      decisionType: decisionForm?.toLowerCase(),
      [CZ_US_RECORD_CARD_METADATA_KEY]: recordCard.state,
      ...(detail === null ? {} : detailMetadata(detail)),
      judge: judge || undefined,
      parallelQuotation: parallelQuotation || undefined,
      popularName: popularName || undefined,
      ecliCounter,
      nalusRecordId,
      nalusSz,
    }),
    rawHash: hashContent(raw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_US],
    documentAst,
    sourceRaw: html,
    sourceRawContentType: "text/html",
  };
};

type HistoricalCursor = {
  phase: typeof SWEEP_PHASE.HISTORICAL;
  availableTo: string;
  year: number;
  pass: CrawlPass;
  page: number;
  digest: string;
  expectedDigest?: string | undefined;
};

/**
 * The recent phase's position, stated as a frontier.
 *
 * `verifiedThrough` is the last closed availability day this walk has listed
 * and verified; the window being walked is the days after it, up to
 * `availableTo`. The two being equal is the steady state: everything the
 * court has closed is accounted for, and the next cycle costs no request at
 * all until a new day closes.
 */
type RecentCursor = {
  phase: typeof SWEEP_PHASE.RECENT;
  verifiedThrough: string;
  availableTo: string;
  pass: CrawlPass;
  page: number;
  digest: string;
  expectedDigest?: string | undefined;
};

type CursorState = HistoricalCursor | RecentCursor;

/**
 * One row of a NALUS result page, as {@link parseResultPage} reads it. This is
 * also the reconciliation payload: the loop parks it verbatim as JSON and
 * replays it through {@link buildCzUsFromPayload}, so every field the fetch
 * and the identity depend on has to live here rather than in the walk.
 */
export type ListedDecision = {
  caseNumber: string;
  counter?: number | undefined;
  identityQuarantined?: true | undefined;
  quarantineId: string;
  quarantineRepairIds: readonly string[];
  listingDocketMissing?: true | undefined;
  listingHtml: string;
  sourceDocumentId: string;
  nalusRecordId?: string | undefined;
  sourceUrl: string;
  sz?: string | undefined;
  ecli?: string | undefined;
};

/**
 * The identity the ingest would store for this listed record.
 *
 * `sourceDocumentId` is the whole rule, and it is minted once, in
 * {@link parseResultPage}: the exact publisher identity where the row exposes
 * one, the content-addressed quarantine identity where it exposes none. Every
 * decision this adapter writes — a parsed one, a listing-only one — carries
 * that same string, so reading it back here is what keeps the crawl, the
 * reconciliation loop and the ledger agreeing about which rows exist.
 *
 * `unidentifiable` is unreachable from a row {@link parseResultPage} built,
 * since both branches produce a persistable id. It is stated anyway because
 * the alternative is silence: an id the decision table would reject can never
 * be held, so counting it as missing would keep the slice short forever.
 */
export const czUsListingIdentity = (listed: ListedDecision): ListingIdentity =>
  isPersistableSourceDocumentId(listed.sourceDocumentId)
    ? { type: "document", sourceDocumentId: listed.sourceDocumentId }
    : { type: "unidentifiable" };

type SearchPage = {
  listed: ListedDecision[];
  rangeFrom: number;
  rangeTo: number;
  reported: number;
};

/**
 * A search page beside the results request that served it.
 *
 * NALUS reaches its listing through a WebForms handshake — a bootstrap GET
 * for the view state, a POST, then the results page — so nothing about the
 * request order names the listing. This carries the one request whose
 * response the rows were parsed from.
 */
type FetchedSearchPage = SearchPage & {
  url: string;
  /** The session the listing was read under; the record cards need it. */
  session: NalusSession;
};

class SearchPageDriftError extends TypeError {
  override name = "SearchPageDriftError";
}

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const LEGACY_CURSOR_PATTERN = /^\d+:\d{4}(?::(?:historical|recent))?$/u;

/**
 * How the recent phase names itself in a cursor.
 *
 * Not the phase name, on purpose: the rolling-window cursor this phase
 * replaced had the same eight fields and named the first availability day it
 * had *not* listed, where the frontier names the last day it verified. Read
 * as a frontier, that string would skip exactly that day, and a forward-only
 * walk never returns to it, so the token is what tells the two apart.
 */
const RECENT_CURSOR_PHASE = "recent-frontier";
const ROLLING_WINDOW_CURSOR_PHASE = "recent";

/** Latest complete NALUS publication day; today's result set is still live. */
const latestClosedAvailabilityDay = (now: Date): string =>
  Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDate()
    .subtract({ days: 1 })
    .toString();

const historicalStart = (now: Date): HistoricalCursor => ({
  phase: SWEEP_PHASE.HISTORICAL,
  availableTo: latestClosedAvailabilityDay(now),
  year: FIRST_YEAR,
  pass: CRAWL_PASS.COLLECT,
  page: 0,
  digest: DIGEST_SEED,
});

const czechDate = (value: string): string => {
  const date = Temporal.PlainDate.from(value);
  return `${date.day}.${date.month}.${date.year}`;
};

const addUtcDays = (day: string, days: number): string =>
  Temporal.PlainDate.from(day).add({ days }).toString();

const parseNonNegativeInteger = (
  value: string | undefined,
  field: string,
): number => {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`Invalid cz-us cursor ${field}`);
  }
  return parsed;
};

const parseCursor = (cursor: string, now: Date): CursorState => {
  // The old probe cursor cannot be translated faithfully: it says which
  // guessed number came next, not which publisher documents were covered.
  // Restart the one-time publisher enumeration to repair that uncertainty.
  if (LEGACY_CURSOR_PATTERN.test(cursor)) {
    return historicalStart(now);
  }

  const parts = cursor.split(":");
  if (parts.at(0) !== "search") {
    throw new TypeError("Invalid cz-us cursor version");
  }

  const phase = parts.at(1);
  if (phase === SWEEP_PHASE.HISTORICAL && parts.length === 8) {
    const availableTo = parts.at(2);
    const year = parseNonNegativeInteger(parts.at(3), "year");
    if (year < FIRST_YEAR) {
      throw new TypeError("Invalid cz-us cursor year");
    }
    const pass = parts.at(4);
    const digest = parts.at(6);
    const expectedDigest = parts.at(7);
    if (
      !availableTo ||
      !ISO_DAY_PATTERN.test(availableTo) ||
      availableTo > latestClosedAvailabilityDay(now) ||
      (pass !== CRAWL_PASS.COLLECT && pass !== CRAWL_PASS.VERIFY) ||
      !digest ||
      (pass === CRAWL_PASS.VERIFY &&
        (!expectedDigest || expectedDigest === "-")) ||
      (pass === CRAWL_PASS.COLLECT && expectedDigest !== "-")
    ) {
      throw new TypeError("Invalid cz-us historical pass");
    }
    return {
      phase,
      availableTo,
      year,
      pass,
      page: parseNonNegativeInteger(parts.at(5), "page"),
      digest,
      ...(expectedDigest === "-" ? {} : { expectedDigest }),
    };
  }
  // A rolling-window cursor persisted before the frontier: its lower bound
  // was inclusive, so the day it names is the first one still unlisted. The
  // window restarts one day before it and runs to the latest closed day; a
  // half-finished pass is dropped rather than translated, because its digest
  // was accumulated over a window that no longer exists.
  const rollingWindowFrom =
    phase === ROLLING_WINDOW_CURSOR_PHASE && parts.length === 8
      ? parts.at(2)
      : undefined;
  if (rollingWindowFrom && ISO_DAY_PATTERN.test(rollingWindowFrom)) {
    return recentFrontier(addUtcDays(rollingWindowFrom, -1), now);
  }
  if (phase === RECENT_CURSOR_PHASE && parts.length === 8) {
    const verifiedThrough = parts.at(2);
    const availableTo = parts.at(3);
    const pass = parts.at(4);
    const digest = parts.at(6);
    const expectedDigest = parts.at(7);
    if (
      !verifiedThrough ||
      !availableTo ||
      !ISO_DAY_PATTERN.test(verifiedThrough) ||
      !ISO_DAY_PATTERN.test(availableTo) ||
      verifiedThrough > availableTo ||
      availableTo > latestClosedAvailabilityDay(now) ||
      (pass !== CRAWL_PASS.COLLECT && pass !== CRAWL_PASS.VERIFY) ||
      !digest ||
      (pass === CRAWL_PASS.VERIFY &&
        (!expectedDigest || expectedDigest === "-")) ||
      (pass === CRAWL_PASS.COLLECT && expectedDigest !== "-")
    ) {
      throw new TypeError("Invalid cz-us availability window");
    }
    return {
      phase: SWEEP_PHASE.RECENT,
      verifiedThrough,
      availableTo,
      pass,
      page: parseNonNegativeInteger(parts.at(5), "page"),
      digest,
      ...(expectedDigest === "-" ? {} : { expectedDigest }),
    };
  }
  throw new TypeError("Invalid cz-us cursor phase");
};

const makeCursor = (state: CursorState): string => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return `search:${state.phase}:${state.availableTo}:${state.year}:${state.pass}:${state.page}:${state.digest}:${state.expectedDigest ?? "-"}`;
    case SWEEP_PHASE.RECENT:
      return `search:${RECENT_CURSOR_PHASE}:${state.verifiedThrough}:${state.availableTo}:${state.pass}:${state.page}:${state.digest}:${state.expectedDigest ?? "-"}`;
    default: {
      state satisfies never;
      return panic(`Unhandled cz-us cursor: ${String(state)}`);
    }
  }
};

const nextSlice = (state: CursorState, now: Date): CursorState => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return state.year <
        Temporal.Instant.fromEpochMilliseconds(
          now.getTime(),
        ).toZonedDateTimeISO("UTC").year
        ? {
            phase: state.phase,
            availableTo: state.availableTo,
            year: state.year + 1,
            pass: CRAWL_PASS.COLLECT,
            page: 0,
            digest: DIGEST_SEED,
          }
        : recentFrontier(state.availableTo, now);
    case SWEEP_PHASE.RECENT:
      return recentFrontier(state.availableTo, now);
    default: {
      state satisfies never;
      return panic(`Unhandled cz-us cursor: ${String(state)}`);
    }
  }
};

/**
 * The recent phase positioned after `verifiedThrough`.
 *
 * Both callers pass the availability bound the slice they just finished was
 * filtered on, which is what makes the handover lossless: the historical
 * sweep pinned every year it walked to one closed day, so the days after it
 * are exactly what no pass has listed yet.
 */
const recentFrontier = (verifiedThrough: string, now: Date): RecentCursor => ({
  phase: SWEEP_PHASE.RECENT,
  verifiedThrough,
  availableTo: latestClosedAvailabilityDay(now),
  pass: CRAWL_PASS.COLLECT,
  page: 0,
  digest: DIGEST_SEED,
});

/** Whether the frontier has caught up with the court's closed days. */
const recentFrontierIsCurrent = (state: RecentCursor): boolean =>
  state.verifiedThrough === state.availableTo;

/**
 * Where the walk goes when a verify pass does not confirm the slice it just
 * collected.
 *
 * The historical sweep re-collects: it is a one-time enumeration of the whole
 * corpus, and a slice it cannot confirm is a slice it may have read short.
 *
 * The recent phase does not. Its window covers closed availability days, so a
 * changed listing means the court back-dated a record rather than that the
 * walk raced it, and re-collecting was what made the phase loop: one verify
 * listing per closed window is its whole budget. What the divergence means for
 * completeness is the reconciliation ledger's question, and it walks decision
 * years independently of this cursor.
 */
const afterUnconfirmedSlice = (
  state: CursorState,
  now: Date,
  reason: string,
): CursorState => {
  if (state.phase === SWEEP_PHASE.HISTORICAL) {
    return restartSlice(state);
  }
  logger.warn("case_law.ingestion.cz_us_recent_window_unconfirmed", {
    adapterKey: ADAPTER_KEYS.CZ_US,
    availableFrom: addUtcDays(state.verifiedThrough, 1),
    availableTo: state.availableTo,
    reason,
  });
  return recentFrontier(state.availableTo, now);
};

const restartSlice = (state: CursorState): CursorState => ({
  ...state,
  pass: CRAWL_PASS.COLLECT,
  page: 0,
  digest: DIGEST_SEED,
  expectedDigest: undefined,
});

const rollingPageDigest = (digest: string, page: SearchPage): string =>
  hashContent(
    `${digest}|${page.reported}|${page.listed
      .map(({ sourceDocumentId }) => sourceDocumentId)
      .join("|")}`,
  );

const hiddenField = (html: string, name: string): string | undefined =>
  cheerio.load(html)(`#${name}`).attr("value");

/**
 * Stable publisher-visible fields for an anomalous row that exposes neither
 * normal NALUS identity. Render position is deliberately absent: WebForms
 * alternates CSS classes and embeds `pos`/`cnt` in links, so hashing the row
 * markup would mint a new quarantine identity whenever result order moves.
 */
const quarantineFingerprint = ({
  stablePrimaryText,
  stableActionsText,
  stableDetailText,
  stableCounterText,
}: {
  stablePrimaryText: string;
  stableActionsText: string;
  stableDetailText: string;
  stableCounterText: string;
}): string => {
  const normalize = (value: string): string =>
    value.replace(/\s+/gu, " ").trim();
  return hashContent(
    JSON.stringify({
      stablePrimaryText: normalize(stablePrimaryText),
      stableActionsText: normalize(stableActionsText),
      stableDetailText: normalize(stableDetailText),
      stableCounterText: normalize(stableCounterText),
    }),
  );
};

const cookieHeader = (responses: readonly Response[]): string => {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";").at(0);
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) {
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
};

const searchFields = (state: CursorState): Record<string, string> => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return {
        ctl00$MainContent$decidedFrom: `1.1.${state.year}`,
        ctl00$MainContent$decidedTo: `31.12.${state.year}`,
        ctl00$MainContent$availableFrom: "1.1.1900",
        ctl00$MainContent$availableTo: czechDate(state.availableTo),
        ctl00$MainContent$razeni: "20",
      };
    case SWEEP_PHASE.RECENT:
      return {
        ctl00$MainContent$availableFrom: czechDate(
          addUtcDays(state.verifiedThrough, 1),
        ),
        ctl00$MainContent$availableTo: czechDate(state.availableTo),
        ctl00$MainContent$razeni: "20",
      };
    default: {
      state satisfies never;
      return panic(`Unhandled cz-us cursor: ${String(state)}`);
    }
  }
};

type ParseResultPageOptions = {
  html: string;
  /** 0-indexed page the request asked for. */
  expectedPage: number;
  /** Rows per page the request asked for; the banner is read against it. */
  pageSize: number;
};

const parseResultPage = ({
  html,
  expectedPage,
  pageSize,
}: ParseResultPageOptions): SearchPage => {
  const banners = [
    ...html.matchAll(
      /Výsledky\s+(?<from>\d+)\s*-\s*(?<to>\d+)\s+z\s+celkem\s+(?<total>\d+)/gu,
    ),
  ].map(({ groups }) => ({
    rangeFrom: Number(groups?.["from"]),
    rangeTo: Number(groups?.["to"]),
    reported: Number(groups?.["total"]),
  }));
  const banner = banners.at(0);
  if (!banner) {
    throw new TypeError("NALUS result count banner is missing");
  }
  if (
    banners.some(
      (candidate) =>
        candidate.rangeFrom !== banner.rangeFrom ||
        candidate.rangeTo !== banner.rangeTo ||
        candidate.reported !== banner.reported,
    )
  ) {
    throw new TypeError("NALUS result count banners disagree");
  }

  const expectedFrom = expectedPage * pageSize + 1;
  if (banner.rangeFrom !== expectedFrom) {
    throw new SearchPageDriftError("NALUS result page moved during traversal");
  }
  if (banner.rangeTo > banner.reported) {
    throw new TypeError("NALUS returned an unexpected result page");
  }

  const $ = cheerio.load(html);
  const listed: ListedDecision[] = [];
  $("tr.resultData0, tr.resultData1").each((_, row) => {
    const primary = $(row);
    if (primary.attr("valign") === "top") {
      return;
    }
    const detail = primary.find("a[href*='ResultDetail.aspx']").first();
    const detailHref = detail.attr("href");
    const nalusRecordId = persistableNalusComponent(
      "nalus-record",
      /[?&]id=(?<id>\d+)/u.exec(detailHref ?? "")?.groups?.["id"],
    );
    const actions = primary.next("tr");
    const linkAction = actions
      .find("[onclick*='GetText.aspx?sz=']")
      .first()
      .attr("onclick");
    const rawUrl =
      /ShowLink\("(?<url>https?:\/\/[^"]+GetText\.aspx\?sz=[^"]+)"/u.exec(
        linkAction ?? "",
      )?.groups?.["url"];
    let sz: string | undefined;
    if (rawUrl) {
      try {
        sz = persistableNalusComponent(
          "nalus-sz",
          new URL(rawUrl).searchParams.get("sz") || undefined,
        );
      } catch {
        // A malformed or withdrawn text action does not erase the stable
        // ResultDetail record identity exposed by the listing.
      }
    }
    const listingHtml = `${primary.toString()}${actions.toString()}`;
    const ecli = persistableNalusComponent(
      "nalus-ecli",
      /ECLI:CZ:US:[^<\s]+/u.exec(primary.html() ?? "")?.at(0),
    );
    const registrySign = detail.text();
    // The count banner says this is a publisher record even if a malformed or
    // withdrawn row exposes neither of NALUS's normal identities. Give that
    // terminal listing a content-addressed quarantine identity derived from
    // semantic fields so one poison row cannot pin the reconciliation slice.
    const exactPublisherIdentity = nalusIdentities({
      recordId: nalusRecordId,
      sz,
      ecli,
    });
    const counterText = /#(?<counter>\d+)\s*$/u.exec(registrySign)?.groups?.[
      "counter"
    ];
    const szCounter = /_(?<counter>\d+)$/u.exec(sz ?? "")?.groups?.["counter"];
    const listedCaseNumber = registrySign.replace(/#\d+\s*$/u, "").trim();
    // Compute the identity-less form for every row. If publisher links are
    // restored later, this becomes a migration alias for the earlier durable
    // quarantine row. Strip every identity-bearing control from the visible
    // text: the detail anchor, ECLI and retrieval action can all appear only
    // when identity metadata recovers, so none may participate in the repair
    // fingerprint.
    const stablePrimary = primary.clone();
    stablePrimary.find("a[href*='ResultDetail.aspx']").remove();
    const stablePrimaryText = stablePrimary.text().replace(ecli ?? "", "");
    const stableActions = actions.clone();
    stableActions
      .find("[onclick*='GetText.aspx?sz='], a[href*='GetText.aspx?sz=']")
      .remove();
    const stableFingerprintFields = {
      stablePrimaryText,
      stableActionsText: stableActions.text(),
    };
    const stableDetailTexts = [...new Set([listedCaseNumber, ""])];
    const stableCounterTexts = [
      ...new Set([counterText ?? szCounter ?? "", ""]),
    ];
    const quarantineRepairIds = stableDetailTexts.flatMap((stableDetailText) =>
      stableCounterTexts.map((stableCounterText) =>
        quarantineFingerprint({
          ...stableFingerprintFields,
          stableDetailText,
          stableCounterText,
        }),
      ),
    );
    const quarantineId =
      quarantineRepairIds[0] ?? panic("Missing quarantine id");
    const publisherIdentity = exactPublisherIdentity ?? {
      sourceDocumentId: `nalus-quarantine:${quarantineId}`,
      aliases: undefined,
    };
    const fallbackCaseNumber =
      exactPublisherIdentity !== null
        ? `NALUS record ${nalusRecordId ?? sz ?? ecli}`
        : `NALUS listing ${quarantineId}`;
    const caseNumber = listedCaseNumber || fallbackCaseNumber;
    const sourceDocumentId = publisherIdentity.sourceDocumentId;

    let sourceUrl: URL;
    if (sz !== undefined) {
      sourceUrl = new URL(TEXT_URL);
      sourceUrl.searchParams.set("sz", sz);
    } else if (nalusRecordId !== undefined) {
      sourceUrl = new URL(RESULT_DETAIL_URL);
      sourceUrl.searchParams.set("id", nalusRecordId);
    } else {
      sourceUrl = new URL(RESULTS_URL);
      sourceUrl.hash = `listing-${quarantineId}`;
    }
    listed.push({
      caseNumber,
      ...(listedCaseNumber ? {} : { listingDocketMissing: true }),
      counter: parseCounter(counterText ?? szCounter),
      sourceDocumentId,
      quarantineId,
      quarantineRepairIds,
      listingHtml,
      ...(exactPublisherIdentity === null ? { identityQuarantined: true } : {}),
      ...(nalusRecordId === undefined ? {} : { nalusRecordId }),
      sourceUrl: sourceUrl.href,
      ...(sz === undefined ? {} : { sz }),
      ecli,
    });
  });

  const expectedRows = banner.rangeTo - banner.rangeFrom + 1;
  if (
    listed.length !== expectedRows ||
    new Set(listed.map(({ sourceDocumentId }) => sourceDocumentId)).size !==
      listed.length
  ) {
    throw new TypeError("NALUS result rows do not match the count banner");
  }
  return { listed, ...banner };
};

/**
 * The longest redirect path this names. A court's own paths are far shorter;
 * the cap exists because the value is publisher-controlled and ends up in a
 * log line.
 */
const REDIRECT_PATH_MAX_CHARS = 200;

/**
 * Why a response this adapter will not follow failed.
 *
 * Every NALUS request is sent with `redirect: "manual"`, because the WebForms
 * search states its result as a 302 that has to be read rather than followed.
 * The gate names the one redirect the court itself defines, its rate-limit
 * refusal; every other redirect reaches a failure branch, where the status
 * alone cannot tell a session bounce from the publisher sending the caller
 * somewhere else entirely.
 *
 * The target is publisher input, so it is named and never fetched (rule 21),
 * and only ever three bounded parts of it are named. Origin and path, never
 * the query, which carries the caller's own request back. Only `http(s)`,
 * because every other scheme has an opaque origin that stringifies to `"null"`
 * and would both misname the target and paste an inline `data:` payload into
 * the log; a scheme is bounded by the URL grammar, so naming it is safe where
 * naming its body is not. And a path truncated to a fixed width, because a
 * redirect can point anywhere and nothing else bounds it.
 */
const httpFailureReason = (response: Response, requestUrl: string): string => {
  if (response.status < 300 || response.status > 399) {
    return `HTTP ${response.status}`;
  }
  const location = response.headers.get("location");
  if (location === null) {
    return `HTTP ${response.status} with no Location`;
  }
  if (!URL.canParse(location, requestUrl)) {
    return `HTTP ${response.status} to an unreadable Location`;
  }
  const { protocol, origin, pathname } = new URL(location, requestUrl);
  if (protocol !== "http:" && protocol !== "https:") {
    return `HTTP ${response.status} to a non-HTTP Location (${protocol})`;
  }
  const path =
    pathname.length > REDIRECT_PATH_MAX_CHARS
      ? `${pathname.slice(0, REDIRECT_PATH_MAX_CHARS)}…`
      : pathname;
  return `HTTP ${response.status} to ${origin}${path}`;
};

/**
 * Whether the search submit's redirect is the court accepting the search.
 *
 * NALUS answers a valid submit with a 302 to the results page and a submit it
 * refuses with a 302 to its error page, so the status alone does not say which
 * happened. Only the target does, and the crawl never follows it: it reads
 * {@link RESULTS_URL} either way, which the court serves as an empty shell
 * once the search behind it failed. Reading the target here keeps a refused
 * search a search failure, rather than one spent request later a results page
 * that parses into nothing.
 */
const redirectsToResults = (response: Response): boolean => {
  const location = response.headers.get("location");
  if (location === null || !URL.canParse(location, SEARCH_URL)) {
    return false;
  }
  const target = new URL(location, SEARCH_URL);
  const results = new URL(RESULTS_URL);
  return (
    target.origin === results.origin && target.pathname === results.pathname
  );
};

/**
 * One NALUS response, with the court's rate-limit refusal raised as the halt
 * it is.
 *
 * The gate reports the refusal as a value, so nothing behind it decides
 * control flow by exception. The crawl raises it at this one seam, where
 * {@link czUsFetchError} is the only handler that can read it, rather than at
 * eight call sites that would each have to remember what a refusal means.
 */
const nalusResponse = async (
  url: string,
  init?: NalusRequestInit,
): Promise<Response> => {
  const response = await fetchNalus(url, init);
  if (Result.isError(response)) {
    throw response.error;
  }
  return response.value;
};

type NalusReadOptions = NalusRequestInit & {
  /** What the failure names: "NALUS <subject> returned …". */
  subject: string;
  url: string;
};

/** {@link nalusResponse} for a read whose every non-OK status is a failure. */
const nalusOkResponse = async ({
  subject,
  url,
  ...init
}: NalusReadOptions): Promise<Response> => {
  const response = await nalusResponse(url, init);
  if (!response.ok) {
    throw new TypeError(
      `NALUS ${subject} returned ${httpFailureReason(response, url)}`,
    );
  }
  return response;
};

type FetchSearchPageOptions = {
  state: CursorState;
  pageSize: number;
  signal?: AbortSignal | undefined;
};

const fetchSearchPage = async ({
  state,
  pageSize,
  signal,
}: FetchSearchPageOptions): Promise<FetchedSearchPage | null> => {
  const first = await nalusOkResponse({
    subject: "search form",
    url: SEARCH_URL,
    signal,
  });
  const formHtml = await first.text();
  const viewState = hiddenField(formHtml, "__VIEWSTATE");
  const validation = hiddenField(formHtml, "__EVENTVALIDATION");
  if (!viewState || !validation) {
    throw new TypeError("NALUS search form is missing WebForms state");
  }

  const form = new URLSearchParams({
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __VIEWSTATE: viewState,
    ...(hiddenField(formHtml, "__VIEWSTATEGENERATOR")
      ? {
          __VIEWSTATEGENERATOR:
            hiddenField(formHtml, "__VIEWSTATEGENERATOR") ?? "",
        }
      : {}),
    __EVENTVALIDATION: validation,
    ctl00$MainContent$nalezy: "on",
    ctl00$MainContent$usneseni: "on",
    ctl00$MainContent$stanoviska_plena: "on",
    ctl00$MainContent$resultsPageSize: String(pageSize),
    ctl00$MainContent$resultsFontSize: "10",
    ctl00$MainContent$but_search: "Vyhledat",
    ...searchFields(state),
  });
  const initialCookies = cookieHeader([first]);
  const submit = await nalusResponse(SEARCH_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: initialCookies,
      Referer: SEARCH_URL,
    },
    body: form.toString(),
  });
  if (submit.status !== 302 || !redirectsToResults(submit)) {
    if (submit.ok) {
      const $ = cheerio.load(await submit.text());
      const noResults = $("#ctl00_MainContent_lbError").text().trim();
      const resultsDisabled =
        $("#ctl00_bResults").attr("disabled") === "disabled";
      if (noResults === NO_RESULTS_MESSAGE && resultsDisabled) {
        return null;
      }
      throw new TypeError("NALUS search did not confirm an empty result set");
    }
    throw new TypeError(
      `NALUS search returned ${httpFailureReason(submit, SEARCH_URL)}`,
    );
  }

  const cookies = cookieHeader([first, submit]);
  const pageUrl =
    state.page === 0 ? RESULTS_URL : `${RESULTS_URL}?page=${state.page}`;
  const results = await nalusOkResponse({
    subject: "results",
    url: pageUrl,
    headers: { Cookie: cookies },
    signal,
  });
  return {
    ...parseResultPage({
      html: await results.text(),
      expectedPage: state.page,
      pageSize,
    }),
    url: pageUrl,
    session: { cookie: cookies },
  };
};

/**
 * What building one listed record produced.
 *
 * `detail-unavailable` still carries the decision the listing alone describes,
 * because the two callers dispose of it differently: the crawl's cursor moves
 * past this record either way, so a listing-only row is worth more to it than
 * nothing, while the reconciliation must refuse it — a detail-less row would
 * make the identity held and take the document out of every later
 * reconciliation.
 */
export type CzUsBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** NALUS lists the record but serves no readable text for it. */
  | { type: "detail-unavailable"; decision: IngestionResult };

/**
 * The court's session, as the one header every record-card read carries.
 *
 * `ResultDetail.aspx` answers a session-less request with a redirect to the
 * search form, so the card cannot be fetched the way the document and the
 * abstract are. A search already establishes one, and the crawl reuses that
 * session for the whole page; a caller with no search of its own opens one.
 */
export type NalusSession = { readonly cookie: string };

export const openNalusSession = async (
  signal?: AbortSignal,
): Promise<NalusSession> => {
  const response = await nalusOkResponse({
    subject: "session",
    url: SEARCH_URL,
    signal,
  });
  await response.text();
  return { cookie: cookieHeader([response]) };
};

/**
 * What one record-card request produced.
 *
 * `absent` is the court's own answer that it holds no card for the record and
 * is durable; `unavailable` is everything else, including the redirect a
 * lapsed session earns, and says nothing about the record. A caller that
 * conflated them would either re-ask forever or give up on a decision that
 * has a card.
 *
 * The three names are the row's own states, so the state a decision carries is
 * the outcome's own tag rather than a second vocabulary mapped onto it.
 * `status` is null where no response was served at all.
 */
export type NalusRecordCardOutcome =
  | { type: typeof CZ_US_RECORD_CARD_STATE.READ; html: string }
  | { type: typeof CZ_US_RECORD_CARD_STATE.ABSENT }
  | {
      type: typeof CZ_US_RECORD_CARD_STATE.UNAVAILABLE;
      status: number | null;
    };

export const fetchNalusRecordCard = async (
  nalusRecordId: string,
  session: NalusSession,
  signal?: AbortSignal,
): Promise<NalusRecordCardOutcome> => {
  const url = new URL(RESULT_DETAIL_URL);
  url.searchParams.set("id", nalusRecordId);
  const response = await nalusResponse(url.href, {
    signal,
    headers: { Cookie: session.cookie },
  });
  if (response.ok) {
    return {
      type: CZ_US_RECORD_CARD_STATE.READ,
      html: await response.text(),
    };
  }
  await response.text();
  return response.status === 404 || response.status === 410
    ? { type: CZ_US_RECORD_CARD_STATE.ABSENT }
    : {
        type: CZ_US_RECORD_CARD_STATE.UNAVAILABLE,
        status: response.status,
      };
};

/** No response was served, so the row states the recoverable gap. */
const CARD_NOT_ASKED = {
  type: CZ_US_RECORD_CARD_STATE.UNAVAILABLE,
  status: null,
} as const satisfies NalusRecordCardOutcome;

/**
 * What a payload with no card part says about the card.
 *
 * A re-parse asks nobody, so the row keeps the answer it already holds: an
 * `absent` the court gave once is not downgraded to a gap a later run would
 * spend a request on.
 */
const storedRecordCardOutcome = (
  metadata: Record<string, unknown>,
): NalusRecordCardOutcome =>
  metadata[CZ_US_RECORD_CARD_METADATA_KEY] === CZ_US_RECORD_CARD_STATE.ABSENT
    ? { type: CZ_US_RECORD_CARD_STATE.ABSENT }
    : CARD_NOT_ASKED;

/**
 * The record card beside the document, where the court served one.
 *
 * A failed card is not a failed decision: the document is the row, and the
 * card's fields are recoverable by the backfill that re-reads it. The outcome
 * is carried through whole rather than collapsed to "no card", so the row
 * states which of the two gaps it is in and only the recoverable one is
 * asked about again.
 */
const fetchRecordCard = async (
  listed: ListedDecision,
  session: NalusSession,
  signal: AbortSignal | undefined,
): Promise<NalusRecordCardOutcome> =>
  listed.nalusRecordId === undefined
    ? CARD_NOT_ASKED
    : await fetchNalusRecordCard(listed.nalusRecordId, session, signal);

/** Every response the court served for one decision. */
export type CzUsDecisionPayloads = {
  listed: ListedDecision;
  textHtml: string;
  /** What the court answered when asked for the record card. */
  recordCard: NalusRecordCardOutcome;
  abstractHtml: string | undefined;
};

/**
 * The card outcome as the build reads it.
 *
 * A page the court served but the detail parser cannot read is not a card:
 * the row states the recoverable gap, exactly as it does for a page the court
 * did not serve, so a later run asks again.
 */
const parsedRecordCard = (
  outcome: NalusRecordCardOutcome,
): ParsedRecordCard => {
  if (outcome.type !== CZ_US_RECORD_CARD_STATE.READ) {
    return { state: outcome.type };
  }
  const fields = parseNalusDetail(outcome.html);
  return fields === null
    ? { state: CZ_US_RECORD_CARD_STATE.UNAVAILABLE }
    : { state: CZ_US_RECORD_CARD_STATE.READ, fields };
};

/**
 * Assemble one decision from the responses the court served for it.
 *
 * Pure: the fetch path and the source-field conformance suite build the same
 * decision from the same payloads, so what the suite certifies is what a
 * crawl stores.
 */
export const buildCzUsDecision = ({
  listed,
  textHtml,
  recordCard,
  abstractHtml,
}: CzUsDecisionPayloads): IngestionResult | null => {
  // Stored whenever the court served a page, whether or not it parsed: the
  // payload is what a re-parse reads instead of asking the court again.
  const detailHtml =
    recordCard.type === CZ_US_RECORD_CARD_STATE.READ
      ? recordCard.html
      : undefined;
  const decision = parseDecisionPage({
    html: textHtml,
    recordCard: parsedRecordCard(recordCard),
    sourceUrl: listed.sourceUrl,
    sourceDocumentId: listed.sourceDocumentId,
    listedEcli: listed.ecli,
    listedCounter: listed.counter,
    nalusRecordId: listed.nalusRecordId,
    nalusSz: listed.sz,
    nalusQuarantineIds: listed.quarantineRepairIds,
  });
  if (!decision) {
    return null;
  }
  if (listed.listingDocketMissing) {
    decision.metadata["listingDocketMissing"] = true;
  }
  decision.textFields =
    abstractHtml === undefined
      ? {
          ...decision.textFields,
          abstract: absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
          legalSentence: absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
        }
      : { ...decision.textFields, ...extractAbstract(abstractHtml) };
  // Text-field and record-card changes must pass the pipeline's source-hash
  // gate, which compares this hash and not the stored payload.
  decision.rawHash = hashContent(
    JSON.stringify({
      abstract: decision.textFields.abstract,
      identityHash: decision.rawHash,
      judges: decision.judges ?? null,
      legalSentence: decision.textFields.legalSentence,
    }),
  );
  Object.assign(
    decision,
    multiResponseSourceRaw({
      listingHtml: listed.listingHtml,
      textHtml,
      detailHtml,
      abstractHtml,
    }),
  );
  return decision;
};

const fetchListedDecision = async (
  listed: ListedDecision,
  session: NalusSession,
  signal: AbortSignal | undefined,
): Promise<CzUsBuildResult> => {
  if (listed.identityQuarantined) {
    return {
      type: "detail-unavailable",
      decision: listedOnlyDecision(listed, "missing-record-identity"),
    };
  }
  if (listed.sz === undefined) {
    return {
      type: "detail-unavailable",
      decision: listedOnlyDecision(listed, "missing-text-action"),
    };
  }
  const response = await nalusResponse(listed.sourceUrl, { signal });
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return {
        type: "detail-unavailable",
        decision: listedOnlyDecision(listed, `http-${response.status}`),
      };
    }
    throw new TypeError(
      `NALUS decision ${listed.sourceDocumentId} returned ${httpFailureReason(
        response,
        listed.sourceUrl,
      )}`,
    );
  }
  const responseHtml = await response.text();

  // A page beside the document: failing to read one is not failing to read
  // the decision, so the caller states what the gap looks like on the row.
  const optionalPage = async <T>(
    read: () => Promise<T>,
    whenUnread: T,
  ): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      // The publisher's rate limit is not an absent page: recording it as one
      // would store the decision without the field and never ask again.
      if (signal?.aborted || error instanceof NalusRateLimitedError) {
        throw error;
      }
      return whenUnread;
    }
  };

  const recordCard = await optionalPage(
    async () => await fetchRecordCard(listed, session, signal),
    CARD_NOT_ASKED,
  );
  const abstractHtml = await optionalPage(async () => {
    const abstractQuery = new URLSearchParams({ sz: listed.sz ?? "" });
    const abstractResponse = await nalusResponse(
      `${ABSTRACT_URL}?${abstractQuery.toString()}`,
      { signal },
    );
    if (!abstractResponse.ok) {
      await abstractResponse.text();
      return undefined;
    }
    return await abstractResponse.text();
  }, undefined);

  const decision = buildCzUsDecision({
    listed,
    textHtml: responseHtml,
    recordCard,
    abstractHtml,
  });
  if (!decision) {
    return {
      type: "detail-unavailable",
      decision: listedOnlyDecision(
        listed,
        "unparseable-detail",
        multiResponseSourceRaw({
          listingHtml: listed.listingHtml,
          textHtml: responseHtml,
          ...(recordCard.type === CZ_US_RECORD_CARD_STATE.READ
            ? { detailHtml: recordCard.html }
            : {}),
        }),
      ),
    };
  }
  return { type: "built", decision };
};

/**
 * Every response fetched for one decision, under the name its role has.
 *
 * The envelope is the only raw form this adapter writes. A plain payload is
 * still read — rows stored before the envelope hold one — and never written
 * again, which is what lets the reader below decide by content type instead
 * of by sniffing the bytes.
 */
const multiResponseSourceRaw = ({
  listingHtml,
  textHtml,
  detailHtml,
  abstractHtml,
}: {
  listingHtml: string;
  textHtml: string;
  detailHtml?: string | undefined;
  abstractHtml?: string | undefined;
}): { sourceRaw: string; sourceRawContentType: string } => ({
  sourceRaw: encodeSourceRawEnvelope({
    listing: listingHtml,
    document: textHtml,
    ...(detailHtml === undefined ? {} : { detail: detailHtml }),
    ...(abstractHtml === undefined ? {} : { abstract: abstractHtml }),
  }),
  sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
});

const listedOnlyDecision = (
  listed: ListedDecision,
  reason: string,
  rawSource?: {
    sourceRaw: string;
    sourceRawContentType: string;
  },
): IngestionResult => {
  const court = czDecisionCourt({
    adapterKey: ADAPTER_KEYS.CZ_US,
    ecli: listed.ecli,
    publisherCourt: CZ_US_PUBLISHER_COURT,
    sourceDocumentId: listed.sourceDocumentId,
  });
  return {
    caseNumber: listed.caseNumber,
    caseNumberIsPlaceholder: listed.listingDocketMissing === true,
    isListingOnly: true,
    sourceDocumentId: listed.sourceDocumentId,
    sourceDocumentIdAliases: nalusIdentities({
      recordId: listed.nalusRecordId,
      sz: listed.sz,
      ecli: listed.ecli,
    })?.aliases,
    sourceDocumentIdRepairAliases:
      listed.identityQuarantined === true
        ? undefined
        : listed.quarantineRepairIds.map(
            (quarantineId) => `nalus-quarantine:${quarantineId}`,
          ),
    legacySourceUrls: legacySourceUrlsFor(
      listed.caseNumber,
      listed.counter,
      listed.sz,
    ),
    ecli: listed.ecli,
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_US].country,
    language: "cs",
    sourceUrl: listed.sourceUrl,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      caseNumber: listed.caseNumber,
      ecli: listed.ecli,
      court,
      ...(listed.nalusRecordId === undefined
        ? {}
        : { nalusRecordId: listed.nalusRecordId }),
      nalusSz: listed.sz,
      listingDocketMissing: listed.listingDocketMissing,
      identityQuarantined: listed.identityQuarantined,
      ecliCounter: listed.counter,
      listedOnly: true,
      listedOnlyReason: reason,
    }),
    rawHash: hashContent(
      `${listed.sourceDocumentId}|${listed.caseNumber}|listed-only|${reason}`,
    ),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_US],
    documentAst: EMPTY_AST,
    sourceRaw:
      rawSource?.sourceRaw ??
      encodeSourceRawEnvelope({ listing: listed.listingHtml }),
    sourceRawContentType:
      rawSource?.sourceRawContentType ?? SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

const fetchListedDecisions = async (
  listed: readonly ListedDecision[],
  session: NalusSession,
  signal: AbortSignal | undefined,
): Promise<IngestionResult[]> => {
  const decisions: IngestionResult[] = [];
  for (let start = 0; start < listed.length; start += DOCUMENT_CONCURRENCY) {
    const batch = listed.slice(start, start + DOCUMENT_CONCURRENCY);
    decisions.push(
      // The crawl keeps a listing-only row for a record NALUS serves no text
      // for: its cursor moves past that record either way, so the observation
      // is worth more than nothing. Only the reconciliation refuses it.
      ...(await Promise.all(
        batch.map(
          async (item) =>
            (await fetchListedDecision(item, session, signal)).decision,
        ),
      )),
    );
    if (start + DOCUMENT_CONCURRENCY < listed.length) {
      await Bun.sleep(100);
    }
  }
  return decisions;
};

// ── Reconciliation ───────────────────────────────────────

/**
 * A reconciliation slice is one decision year, `YYYY`, which is exactly what
 * the search form's `decidedFrom`/`decidedTo` pair addresses and what the
 * crawl's historical phase already walks. Four digits sort lexicographically
 * in chronological order, which is the ordering the ledger relies on.
 *
 * The year rather than a finer unit because NALUS states a total for whatever
 * range it is asked about, and a year is comfortably walkable: the court's
 * busiest years are around four thousand decisions (4,345 decided in 2013), so
 * a slice is roughly 55 pages of {@link LISTING_PAGE_SIZE} against the engine's
 * 200-page ceiling. A month would triple the request count to prove the same
 * thing, and the court sits few enough days that most days would be empty.
 */
const CZ_US_FIRST_SLICE = String(FIRST_YEAR);

const SLICE_PATTERN = /^\d{4}$/u;

const parseSlice = (slice: string): number => {
  if (!SLICE_PATTERN.test(slice)) {
    panic(`cz-us slice is not a decision year: ${slice}`);
  }
  return Number.parseInt(slice, 10);
};

const czUsSliceOf = (now: Date): string =>
  String(
    Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
      "UTC",
    ).year,
  );

const czUsNextSlice = (slice: string): string | null => {
  const next = parseSlice(slice) + 1;
  return next > Temporal.Now.plainDateISO("UTC").year ? null : String(next);
};

const czUsPreviousSlice = (slice: string): string | null => {
  const previous = parseSlice(slice) - 1;
  return previous < FIRST_YEAR ? null : String(previous);
};

/**
 * Slices near the tip that get re-walked on a fast cadence. The contract
 * counts slices, not days, so for this adapter the window is two years: the
 * current one and the one before it.
 *
 * Two rather than one because a decision made in December is often released
 * the following spring, so on any January day the year that still gains
 * documents is last year's. A slice outside the window is re-walked only when
 * the ledger already recorded it short, which is exactly what a completed
 * older year is not.
 */
const CZ_US_TIP_WINDOW_SLICES = 2;

/**
 * One page of the publisher's own listing for a decision year, with no text or
 * abstract fetches.
 *
 * The availability filter is pinned to the latest closed publication day, the
 * same bound the crawl uses: NALUS keeps the current day's result set live, so
 * a walk that included it would list rows that move underneath it.
 *
 * A failed request is thrown, never flattened into an empty page. The crawl
 * can afford to read a dead search as "nothing here" because a cursor that
 * moves on can be walked again; a ledger row cannot, since an outage recorded
 * as an empty year makes that year settled and it is never revisited. So only
 * the publisher's own stated-empty answer — the no-records message with the
 * results button disabled, which {@link fetchSearchPage} alone returns `null`
 * for — is an empty slice. A missing count banner, a 5xx, a page that moved
 * underneath the request: all throw, and the engine retries on a later pass.
 */
const listCzUsSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const listing = await fetchSearchPage({
    state: {
      phase: SWEEP_PHASE.HISTORICAL,
      availableTo: latestClosedAvailabilityDay(new Date()),
      year: parseSlice(slice),
      pass: CRAWL_PASS.COLLECT,
      page,
      digest: DIGEST_SEED,
    },
    pageSize: LISTING_PAGE_SIZE,
    signal,
  });
  if (listing === null) {
    return { items: [], totalPages: 0 };
  }
  return {
    items: listing.listed.map((listed) => ({
      identity: czUsListingIdentity(listed),
      payload: listed,
    })),
    totalPages: Math.ceil(listing.reported / LISTING_PAGE_SIZE),
  };
};

/**
 * Validate a payload the loop stored verbatim.
 *
 * Revalidated rather than trusted: it may have been parked for days, and a
 * shape this adapter no longer produces has to be reported as unbuildable
 * instead of replayed on faith. Every field {@link fetchListedDecision} reads
 * is checked, because a payload missing one of them would otherwise fetch the
 * wrong document or mint a different identity than the walk keyed it under.
 */
const isListedDecision = (value: unknown): value is ListedDecision => {
  if (!isRecord(value)) {
    return false;
  }
  // Field names are typed against `ListedDecision`, so renaming one here is a
  // typecheck failure rather than a guard that silently stops checking it.
  const isString = (field: keyof ListedDecision): boolean =>
    typeof value[field] === "string";
  const isOptionalString = (field: keyof ListedDecision): boolean =>
    value[field] === undefined || isString(field);
  const isOptionalTrue = (field: keyof ListedDecision): boolean =>
    value[field] === undefined || value[field] === true;
  return (
    isString("caseNumber") &&
    isString("sourceDocumentId") &&
    isString("quarantineId") &&
    isString("listingHtml") &&
    isString("sourceUrl") &&
    isUnknownArray(value["quarantineRepairIds"]) &&
    value["quarantineRepairIds"].every((id) => typeof id === "string") &&
    (value["counter"] === undefined || typeof value["counter"] === "number") &&
    isOptionalString("nalusRecordId") &&
    isOptionalString("sz") &&
    isOptionalString("ecli") &&
    isOptionalTrue("identityQuarantined") &&
    isOptionalTrue("listingDocketMissing")
  );
};

/**
 * Replay one listed record through the adapter's own fetch and parse path.
 *
 * A record the listing names but whose text NALUS does not serve is reported,
 * not stored: the listing-only row {@link fetchListedDecision} still builds is
 * right for the crawl and wrong here, because writing it would make the
 * identity held and take the document out of every later reconciliation.
 */
const buildCzUsFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (
    !isListedDecision(payload) ||
    czUsListingIdentity(payload).type === "unidentifiable"
  ) {
    return { type: "unkeyable" };
  }
  const built = await fetchListedDecision(
    payload,
    await openNalusSession(signal),
    signal,
  );
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "detail-unavailable":
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled cz-us build result: ${JSON.stringify(built)}`);
    }
  }
};

const CZ_US_REPARSABLE_CONTENT_TYPES = new Set([
  "application/json",
  "text/html",
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
]);

/** Read both the current envelope and the JSON shape stored before it. */
const czUsStoredRawParts = (
  raw: string,
  contentType: string | null,
): SourceRawParts | null => {
  const envelope = decodeSourceRawEnvelope(raw);
  if (envelope !== null) {
    return envelope;
  }
  if (contentType === null || contentType === "text/html") {
    return { document: raw };
  }
  if (contentType !== "application/json") {
    return null;
  }
  const parsed = Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
  if (!isRecord(parsed) || typeof parsed["textHtml"] !== "string") {
    return null;
  }
  return {
    document: parsed["textHtml"],
    ...(typeof parsed["listingHtml"] === "string"
      ? { listing: parsed["listingHtml"] }
      : {}),
    ...(typeof parsed["abstractHtml"] === "string"
      ? { abstract: parsed["abstractHtml"] }
      : {}),
  };
};

/**
 * Rebuild a NALUS decision solely from its saved source responses. Rows from
 * before the multi-page envelope retain their metadata because their raw HTML
 * has no abstract page; envelope rows re-project the original abstract block
 * breaks without contacting the publisher.
 */
const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (
    stored.contentType !== null &&
    !CZ_US_REPARSABLE_CONTENT_TYPES.has(stored.contentType)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored content type ${stored.contentType}`,
    };
  }
  if (stored.sourceDocumentId === null || stored.sourceUrl === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "missing source document id or source URL",
    };
  }

  const raw = new TextDecoder().decode(stored.raw);
  const parts = czUsStoredRawParts(raw, stored.contentType);
  const documentHtml = parts?.["document"];
  if (documentHtml === undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: `no decision document in the stored payload for ${stored.caseNumber}`,
    };
  }

  const listedCounter = stored.metadata["ecliCounter"];
  const nalusRecordId = stored.metadata["nalusRecordId"];
  const nalusSz = stored.metadata["nalusSz"];
  const detailHtml = parts?.["detail"];
  const decision = parseDecisionPage({
    html: documentHtml,
    recordCard: parsedRecordCard(
      detailHtml === undefined
        ? storedRecordCardOutcome(stored.metadata)
        : { type: CZ_US_RECORD_CARD_STATE.READ, html: detailHtml },
    ),
    sourceUrl: stored.sourceUrl,
    sourceDocumentId: stored.sourceDocumentId,
    listedEcli: stored.ecli ?? undefined,
    listedCounter:
      typeof listedCounter === "number" ? listedCounter : undefined,
    nalusRecordId:
      typeof nalusRecordId === "string" ? nalusRecordId : undefined,
    nalusSz: typeof nalusSz === "string" ? nalusSz : undefined,
    nalusQuarantineIds: [],
  });
  if (decision === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: `stored decision document could not be parsed for ${stored.caseNumber}`,
    };
  }
  if (decision.caseNumber !== stored.caseNumber) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `stored document states ${decision.caseNumber}`,
    };
  }

  decision.metadata = checkedDecisionMetadata({
    ...stored.metadata,
    ...decision.metadata,
  });
  const abstractHtml = parts?.["abstract"];
  if (abstractHtml !== undefined) {
    decision.textFields = {
      ...decision.textFields,
      ...extractAbstract(abstractHtml),
    };
  }
  decision.sourceRaw = raw;
  decision.sourceRawContentType = stored.contentType ?? "text/html";
  return { type: "parsed", result: decision };
};

// ── Adapter ──────────────────────────────────────────────

/**
 * How a failed page is reported.
 *
 * The publisher's own rate limit gets its own halt rather than the generic
 * fetch failure: it carries the refusal's status, so
 * `case_law.ingestion.adapter_halted` names the limit and its HTTP status
 * instead of a redirect nobody can read. The cursor is untouched either way —
 * an `Err` never reaches the pipeline's checkpoint — so the next cycle
 * resumes where this one stopped and costs one request to learn whether the
 * limit is still in force.
 */
const czUsFetchError =
  (cursor: string | null) =>
  (cause: unknown): AdapterFetchError =>
    cause instanceof NalusRateLimitedError
      ? new AdapterFetchError({
          message: cause.message,
          adapterKey: ADAPTER_KEYS.CZ_US,
          cursor,
          httpStatus: cause.httpStatus,
          cause,
        })
      : adapterCatch(ADAPTER_KEYS.CZ_US, cursor)(cause);

/**
 * Every page this court serves for one decision, and whether the row keeps it.
 *
 * The four it keeps are the four the crawl reads: the result row, the document
 * with its rich-text field, the abstract and the record card. The rest of the
 * list is this court's export and print machinery, which restates what those
 * four already carry and reaches it through a form postback that costs a page
 * load for its tokens before it can be asked at all.
 */
const SOURCE_SURFACES = [
  "session-bootstrap",
  "listing",
  "document",
  "abstract",
  "detail",
  "document-rtf-export",
  "document-print",
  "detail-word-export",
  "detail-print",
  "detail-abstract-panel",
  "hit-excerpt",
  "citation-clipboard",
] as const;

const NALUS_SOURCE_SURFACES = {
  surfaces: {
    "session-bootstrap": excludedSourceSurface(
      "the search form, which states no field of any decision and is read only to open the session the record card needs",
    ),
    listing: storedSourceSurface("listing"),
    document: storedSourceSurface("document"),
    abstract: storedSourceSurface("abstract"),
    detail: storedSourceSurface("detail"),
    "document-rtf-export": excludedSourceSurface(
      "a word-processor rendering of the same text the document part already carries in its hidden field",
    ),
    "document-print": excludedSourceSurface(
      "the document under a print stylesheet",
    ),
    "detail-word-export": excludedSourceSurface(
      "a word-processor rendering of the rows the record card part already carries",
    ),
    "detail-print": excludedSourceSurface(
      "the record card under a print stylesheet",
    ),
    "detail-abstract-panel": excludedSourceSurface(
      "the panel served by the same endpoint as the abstract part",
    ),
    "hit-excerpt": excludedSourceSurface(
      "a snippet cut around the query that produced it, so it states nothing the decision itself does not",
    ),
    "citation-clipboard": excludedSourceSurface(
      "a citation assembled from fields the row already stores",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

export const czUsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_US,
  sourceSurfaces: NALUS_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: NALUS_SOURCE_FIELDS,
    listSourceFields: listNalusSourceFields,
  },
  language: "cs",
  minRequestIntervalMs: 100,
  pageTimeoutMs: CZ_US_PAGE_TIMEOUT_MS,
  maxSyncPages: 10,
  maxCycleMs: CZ_US_MAX_CYCLE_MS,
  reparseStoredRaw,

  /**
   * NALUS reports its total only on a search result page, and a search
   * demands a session: the form's ViewState fields and cookies from a GET,
   * a POST carrying them plus at least one criterion (an all-inclusive date
   * range excludes nothing), then the redirected results page, which states
   * "z celkem N".
   */
  async getTotalCount(signal) {
    try {
      const first = await nalusResponse(SEARCH_URL, { signal });
      if (!first.ok) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }
      const cookies = first.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const html = await first.text();
      const hidden = (name: string): string | null => {
        const match = new RegExp(`id="${name}" value="([^"]*)"`, "u").exec(
          html,
        );
        return match?.[1] ?? null;
      };
      const viewState = hidden("__VIEWSTATE");
      const generator = hidden("__VIEWSTATEGENERATOR");
      const validation = hidden("__EVENTVALIDATION");
      if (viewState === null || validation === null) {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }
      const form = new URLSearchParams({
        __VIEWSTATE: viewState,
        ...(generator === null ? {} : { __VIEWSTATEGENERATOR: generator }),
        __EVENTVALIDATION: validation,
        ctl00$MainContent$nalezy: "on",
        ctl00$MainContent$usneseni: "on",
        ctl00$MainContent$stanoviska_plena: "on",
        ctl00$MainContent$decidedFrom: "1.1.1900",
        ctl00$MainContent$decidedTo: `31.12.${Temporal.Now.plainDateISO().year + 1}`,
        ctl00$MainContent$but_search: "Vyhledat",
      });
      const submit = await nalusResponse(SEARCH_URL, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies,
        },
        body: form.toString(),
      });
      if (submit.status !== 302 && !submit.ok) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }
      const results = await nalusResponse(RESULTS_URL, {
        signal,
        headers: { Cookie: cookies },
      });
      if (!results.ok) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }
      const total = /z celkem (?<n>\d+)/u.exec(await results.text())?.groups?.[
        "n"
      ];
      return total === undefined
        ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
        : sourceTotalRead(Number.parseInt(total, 10));
    } catch (error) {
      return { type: "probe-failed", errorTag: errorTag(error) };
    }
  },

  /**
   * The search form answers a decision-date range on its own, so what a year
   * holds is answerable without the crawl cursor ever reaching it: list the
   * year, key each record the way the ingest would, and compare against what
   * is held. This loop is the only writer of coverage for this source.
   */
  reconciliation: {
    firstSlice: CZ_US_FIRST_SLICE,
    sliceOf: czUsSliceOf,
    nextSlice: czUsNextSlice,
    previousSlice: czUsPreviousSlice,
    tipWindowDays: CZ_US_TIP_WINDOW_SLICES,
    // The crawl keeps the row `listedOnlyDecision` builds when NALUS serves no
    // readable text, and marks it `isListingOnly`; unset, that stub would count
    // as held and its document would never be hunted again. This source stores
    // whole decisions by design, so a detail-less row here is always a failed
    // fetch rather than a legitimate metadata-only state.
    heldRequiresDetail: true,
    listSlicePage: listCzUsSlicePage,
    buildDecision: buildCzUsFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const now = new Date();
        let state = cursor ? parseCursor(cursor, now) : historicalStart(now);
        if (
          state.phase === SWEEP_PHASE.RECENT &&
          recentFrontierIsCurrent(state)
        ) {
          const rearmed = recentFrontier(state.availableTo, now);
          if (recentFrontierIsCurrent(rearmed)) {
            // Every closed availability day is accounted for, so there is
            // nothing to list and no request to spend. An unchanged cursor is
            // how this pipeline reads a source with nothing left.
            return { decisions: [], nextCursor: makeCursor(state) };
          }
          state = rearmed;
        }
        let page: FetchedSearchPage | null;
        try {
          page = await fetchSearchPage({
            state,
            pageSize: RESULTS_PAGE_SIZE,
            signal,
          });
        } catch (error) {
          if (state.page > 0 && error instanceof SearchPageDriftError) {
            return {
              decisions: [],
              nextCursor: makeCursor(restartSlice(state)),
            };
          }
          throw error;
        }
        if (page === null) {
          if (state.pass === CRAWL_PASS.VERIFY) {
            return {
              decisions: [],
              nextCursor: makeCursor(
                afterUnconfirmedSlice(state, now, "listing-now-empty"),
              ),
            };
          }
          return {
            decisions: [],
            nextCursor: makeCursor(nextSlice(state, now)),
          };
        }

        const digest = rollingPageDigest(state.digest, page);
        const sliceComplete = page.rangeTo === page.reported;
        if (state.pass === CRAWL_PASS.VERIFY) {
          if (!sliceComplete) {
            return {
              decisions: [],
              nextCursor: makeCursor({
                ...state,
                page: state.page + 1,
                digest,
              }),
            };
          }
          if (digest !== state.expectedDigest) {
            return {
              decisions: [],
              nextCursor: makeCursor(
                afterUnconfirmedSlice(state, now, "digest-mismatch"),
              ),
            };
          }
          return {
            decisions: [],
            nextCursor: makeCursor(nextSlice(state, now)),
          };
        }

        const decisions = await fetchListedDecisions(
          page.listed,
          page.session,
          signal,
        );
        if (sliceComplete) {
          return {
            decisions,
            nextCursor: makeCursor({
              ...state,
              pass: CRAWL_PASS.VERIFY,
              page: 0,
              digest: DIGEST_SEED,
              expectedDigest: digest,
            }),
            sourceUrl: page.url,
          };
        }
        return {
          decisions,
          nextCursor: makeCursor({
            ...state,
            page: state.page + 1,
            digest,
          }),
          sourceUrl: page.url,
        };
      },
      catch: czUsFetchError(cursor),
    });
  },
});
