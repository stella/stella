import { panic } from "better-result";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import type { ParserParityEntry } from "@/api/handlers/case-law/ingestion/parsers/parity-manifest";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";

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
}: IngestionResult): ParserParityOutput => ({
  fulltext,
  sections,
  documentAst,
  parserVersion,
});

export const parserParityOutput = async (
  entry: ParserParityEntry,
): Promise<ParserParityOutput> => {
  const adapter =
    getAdapter(entry.adapterKey) ??
    panic(`Unknown parity adapter ${entry.adapterKey}`);
  const fixtureFactory = CASE_LAW_CONFORMANCE_FIXTURES[entry.adapterKey];
  const decision = await fixtureFactory().buildDecision();
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
