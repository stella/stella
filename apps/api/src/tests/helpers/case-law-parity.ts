import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/bun";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import type { ParserParityEntry } from "@/api/handlers/case-law/ingestion/parsers/parity-manifest";
import {
  euEcjFixture,
  huBhgyFixture,
  plNsaFixture,
  plUodoFixture,
  skUsFixture,
  ukFclFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import type { EnrolledAdapterFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";

const INGESTION_ROOT = new URL(
  "../../handlers/case-law/ingestion/",
  import.meta.url,
);

export type ParserParityOutput = Pick<
  IngestionResult,
  "fulltext" | "sections" | "documentAst" | "parserVersion"
>;

const parityOutputOf = ({
  fulltext,
  sections,
  documentAst,
  parserVersion,
}: IngestionResult): ParserParityOutput => {
  if (fulltext === undefined || fulltext.trim().length === 0) {
    return panic(
      "Parser parity requires a parsed document, not a listing-only outcome",
    );
  }
  return { fulltext, sections, documentAst, parserVersion };
};

const PARITY_FIXTURES = {
  [ADAPTER_KEYS.EU_ECJ]: euEcjFixture,
  [ADAPTER_KEYS.HU_BHGY]: huBhgyFixture,
  [ADAPTER_KEYS.UK_FCL]: ukFclFixture,
  [ADAPTER_KEYS.PL_NSA]: plNsaFixture,
  [ADAPTER_KEYS.PL_UODO]: plUodoFixture,
  [ADAPTER_KEYS.SK_US]: skUsFixture,
} as const satisfies Record<
  ParserParityEntry["adapterKey"],
  (documentUrl: URL) => EnrolledAdapterFixture
>;

export const buildCaseLawFixture = async (fixture: EnrolledAdapterFixture) => {
  const originalFetch = globalThis.fetch;
  try {
    return await fixture.buildDecision();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

export const parserParityOutput = async (
  entry: ParserParityEntry,
): Promise<ParserParityOutput> => {
  const adapter =
    getAdapter(entry.adapterKey) ??
    panic(`Unknown parity adapter ${entry.adapterKey}`);
  const fixtureFactory = PARITY_FIXTURES[entry.adapterKey];
  const decision = await buildCaseLawFixture(
    fixtureFactory(new URL(entry.fixture, INGESTION_ROOT), entry.identity),
  );
  const reparse = adapter.reparseStoredRaw;
  if (reparse === undefined || decision.sourceRaw === undefined) {
    return parityOutputOf(decision);
  }

  const replayed = await reparse({
    raw: new TextEncoder().encode(decision.sourceRaw),
    contentType: decision.sourceRawContentType ?? null,
    caseNumber: decision.caseNumber,
    sourceDocumentId: decision.sourceDocumentId ?? null,
    language: decision.language,
    court: decision.court,
    ecli: decision.ecli ?? null,
    decisionDate: decision.decisionDate ?? null,
    decisionType: decision.decisionType ?? null,
    sourceUrl: decision.sourceUrl ?? null,
    documentUrl: decision.documentUrl ?? null,
    metadata: decision.metadata,
  });
  if (replayed.type !== "parsed") {
    return panic(
      `${entry.fixture}: stored-raw replay was rejected (${replayed.type})`,
    );
  }
  return parityOutputOf(replayed.result);
};

export const parityGoldenUrl = (entry: ParserParityEntry): URL =>
  new URL(
    `__goldens__/${entry.fixture.replace("/__fixtures__/", "/")}.golden.json`,
    INGESTION_ROOT,
  );

const stableReplayValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableReplayValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .toSorted(([left], [right]) => compareCodeUnit(left, right))
        .map(([key, child]) => [key, stableReplayValue(child)]),
    );
  }
  return value;
};

export const replayParsedOutput = ({
  sourceRaw: _sourceRaw,
  sourceRawBytes: _sourceRawBytes,
  sourceRawObjects: _sourceRawObjects,
  ...output
}: IngestionResult): string => JSON.stringify(stableReplayValue(output));

export const replayParserFingerprint = (decision: IngestionResult): string =>
  sha256Hex(replayParsedOutput(decision));
