/**
 * A crawl-sized stream of CourtListener decisions for ingestion tests and
 * measurements, derived from the recorded snapshot clusters: their real
 * opinion markup, dockets, reporter citations and judge rows, re-keyed per
 * record. Deterministic: the same count and namespace give the same records,
 * so a separate process can rebuild exactly what a test applies.
 *
 * Each record cites two others of the stream by reporter citation (one
 * earlier, one later), so citations resolve both against stored rows and
 * against decisions that arrive after them. Every 41st record repeats the
 * previous record's docket and primary reporter citation (a second decision
 * reported under one citation: its case number, slug and docket key
 * collide, and citations to it are ambiguous), and every 97th repeats an
 * earlier record's cluster with revised text (a second observation of one
 * publisher identity).
 */
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { mapCourtListenerRecord as uncheckedMapCourtListenerRecord } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/map";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const mapCourtListenerRecord = guardParser(uncheckedMapCourtListenerRecord);

type Row = Record<string, string>;

type RecordedCluster = {
  cluster: Row;
  docket: Row;
  opinions: Row[];
  citations: Row[];
  judgeRelations:
    | { status: "unavailable" }
    | {
        status: "complete";
        people: Row[];
        joinedBy: { opinionId: string; personId: string }[];
      };
  provenance: Record<string, unknown> & { expectedOpinionIds: string[] };
} & Record<string, unknown>;

const isRecordedCluster = (value: unknown): value is RecordedCluster =>
  isRecord(value) &&
  isRecord(value["cluster"]) &&
  isRecord(value["docket"]) &&
  Array.isArray(value["opinions"]) &&
  Array.isArray(value["citations"]) &&
  isRecord(value["provenance"]);

const recordedClusters = (): RecordedCluster[] =>
  gunzipSync(
    readFileSync(
      new URL(
        "../../handlers/case-law/ingestion/adapters/__fixtures__/courtlistener-clusters-2026-06-30.ndjson.gz",
        import.meta.url,
      ),
    ),
  )
    .toString("utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line): RecordedCluster => {
      const parsed: unknown = JSON.parse(line);
      return isRecordedCluster(parsed)
        ? parsed
        : panic("A recorded cluster lost its shape");
    });

/** The reporter citation a fixture record is published under. */
export const fixtureReporterCitation = (namespace: number, index: number) => ({
  volume: String(namespace),
  reporter: "U.S.",
  page: String(1000 + index),
});

const citationText = (namespace: number, index: number) => {
  const { volume, reporter, page } = fixtureReporterCitation(namespace, index);
  return `${volume} ${reporter} ${page}`;
};

const TEXT_COLUMNS = [
  "xml_harvard",
  "html_with_citations",
  "html_lawbox",
  "html_columbia",
  "html_anon_2020",
  "html",
  "plain_text",
] as const;

/** Add a paragraph to one text form: inside its last element for markup. */
const withTextParagraph = (
  column: (typeof TEXT_COLUMNS)[number],
  text: string,
  paragraph: string,
): string => {
  if (column === "plain_text") {
    return `${text}\n\n${paragraph}`;
  }
  const close = text.lastIndexOf("</");
  return close > 0
    ? `${text.slice(0, close)}<p>${paragraph}</p>${text.slice(close)}`
    : `${text}<p>${paragraph}</p>`;
};

/** Add a paragraph to every stated text form of an opinion. */
const withParagraph = (opinion: Row, paragraph: string): Row => {
  const stated = TEXT_COLUMNS.filter(
    (column) => (opinion[column] ?? "") !== "",
  );
  if (stated.length === 0) {
    return { ...opinion, html_with_citations: `<p>${paragraph}</p>` };
  }
  return {
    ...opinion,
    ...Object.fromEntries(
      stated.map((column) => [
        column,
        withTextParagraph(column, opinion[column] ?? "", paragraph),
      ]),
    ),
  };
};

type IngestFixtureOptions = {
  count: number;
  /**
   * A reporter volume no other fixture in the database uses, so this
   * stream's citations resolve only within it.
   */
  namespace: number;
};

/** The source records, before the adapter maps them. */
export const courtListenerFixtureRecords = ({
  count,
  namespace,
}: IngestFixtureOptions): RecordedCluster[] => {
  const templates = recordedClusters();
  return Array.from({ length: count }, (_, index) => {
    const template =
      templates[index % templates.length] ??
      panic("The recorded clusters are empty");
    const revisionOf = index % 97 === 96 ? index - 3 : null;
    const docketOf = revisionOf ?? (index % 41 === 40 ? index - 1 : index);
    const identity = revisionOf ?? index;
    const clusterId = String(namespace * 100_000 + identity);
    const docketId = String(namespace * 100_000 + docketOf);
    const earlier = (index * 37 + 11) % Math.max(index, 1);
    const later = Math.min(index + 1 + (index % 5), count - 1);
    const paragraph = `See ${citationText(namespace, earlier)} (1991); compare ${citationText(namespace, later)}.${
      revisionOf === null ? "" : " Opinion revised on rehearing."
    }`;
    const opinions = template.opinions.map((opinion, part) =>
      withParagraph(
        {
          ...opinion,
          id: String(namespace * 1_000_000 + identity * 10 + part),
          cluster_id: clusterId,
        },
        paragraph,
      ),
    );
    const opinionIds = new Map(
      template.opinions.map((opinion, part) => [
        opinion["id"] ?? "",
        opinions[part]?.["id"] ?? "",
      ]),
    );
    const judgeRelations =
      template.judgeRelations.status === "complete"
        ? {
            ...template.judgeRelations,
            joinedBy: template.judgeRelations.joinedBy.map((joined) => ({
              ...joined,
              opinionId: opinionIds.get(joined.opinionId) ?? joined.opinionId,
            })),
          }
        : template.judgeRelations;
    const [first, ...rest] = template.citations;
    return {
      ...template,
      cluster: {
        ...template.cluster,
        id: clusterId,
        docket_id: docketId,
        slug: `fixture-${namespace}-${identity}`,
      },
      docket: {
        ...template.docket,
        id: docketId,
        docket_number: `No. ${namespace}-${docketOf}`,
        docket_number_core: `${namespace}${String(docketOf).padStart(5, "0")}`,
        docket_number_raw: `No. ${namespace}-${docketOf}`,
      },
      opinions,
      citations: [
        {
          ...first,
          id: String(namespace * 1_000_000 + identity * 10),
          cluster_id: clusterId,
          ...fixtureReporterCitation(namespace, docketOf),
        },
        ...rest.map((citation, part) => ({
          ...citation,
          id: String(namespace * 1_000_000 + identity * 10 + part + 1),
          cluster_id: clusterId,
          volume: String(namespace + 1),
        })),
      ],
      judgeRelations,
      provenance: {
        ...template.provenance,
        expectedOpinionIds: opinions.map(
          (opinion) => opinion["id"] ?? panic("An opinion lost its id"),
        ),
      },
    };
  });
};

/** The stream as the adapter maps it, in record order. */
export const courtListenerIngestFixture = (
  options: IngestFixtureOptions,
): IngestionResult[] =>
  courtListenerFixtureRecords(options).map((record) =>
    mapCourtListenerRecord(record).unwrap(
      "a re-keyed recorded cluster maps to a decision",
    ),
  );
