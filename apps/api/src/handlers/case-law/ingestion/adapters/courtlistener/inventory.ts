/**
 * Every field and surface of a CourtListener record, and its fate. Field
 * dispositions are declared per column beside the pinned headers; this module
 * names them as `listSourceFields` reads them back out of the stored raw.
 */

import { Result } from "better-result";

import {
  excludedSourceSurface,
  type SourceFieldDisposition,
  type SourceFieldInventory,
  type SourceRawParts,
  type SourceSurfaceCensus,
  type SourceSurfaceDisposition,
  storedSourceSurface,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

import { COURTLISTENER_RAW_PART } from "./raw";
import {
  CITATION_FIELDS,
  CLUSTER_FIELDS,
  COURT_FIELDS,
  DOCKET_FIELDS,
  OPINION_FIELDS,
  PERSON_FIELDS,
} from "./snapshot-columns";

const JUDGES: SourceFieldDisposition = {
  disposition: "stored",
  target: { type: "result", key: "judges" },
};

/** Each raw part's rows, under the prefix their field names are listed with. */
const PART_FIELDS = [
  [COURTLISTENER_RAW_PART.CLUSTER, "cluster.", CLUSTER_FIELDS],
  [COURTLISTENER_RAW_PART.DOCKET, "docket.", DOCKET_FIELDS],
  [COURTLISTENER_RAW_PART.COURT, "court.", COURT_FIELDS],
  [COURTLISTENER_RAW_PART.OPINIONS, "opinions[].", OPINION_FIELDS],
  [COURTLISTENER_RAW_PART.CITATIONS, "citations[].", CITATION_FIELDS],
] as const;
const PEOPLE = "people[].";
const JOINDERS = "joinedBy[].";

type PrefixedFieldsOptions = {
  prefix: string;
  part: string;
  rowPath: readonly string[];
  fields: Readonly<Record<string, SourceFieldDisposition>>;
};

const prefixed = ({ prefix, part, rowPath, fields }: PrefixedFieldsOptions) =>
  Object.entries(fields).map(
    ([name, disposition]) =>
      [
        `${prefix}${name}`,
        disposition.disposition === "excluded" ||
        (disposition.target.type === "document" && name !== "headmatter")
          ? ({
              disposition: "stored",
              target: {
                type: "raw",
                part,
                path: [...rowPath, name],
                reason:
                  disposition.disposition === "excluded"
                    ? disposition.reason
                    : "Alternate source text is retained verbatim; the selected rendition forms the document",
              },
            } as const)
          : disposition,
      ] as const,
  );

const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value.flatMap((row) => (isRecord(row) ? Object.keys(row) : [])),
      ),
    ];
  }
  return isRecord(value) ? Object.keys(value) : [];
};

const parsePart = (text: string | undefined): unknown =>
  Result.try({
    try: (): unknown => JSON.parse(text ?? "null"),
    catch: () => null,
  }).unwrapOr(null);

/** Every field name the stored envelope states, across all of its parts. */
const listSourceFields = (parts: SourceRawParts): readonly string[] => {
  const relations = parsePart(parts[COURTLISTENER_RAW_PART.JUDGE_RELATIONS]);
  return [
    ...PART_FIELDS.flatMap(([part, prefix]) =>
      keysOf(parsePart(parts[part])).map((name) => `${prefix}${name}`),
    ),
    ...(isRecord(relations)
      ? [
          ...keysOf(relations["people"]).map((name) => `${PEOPLE}${name}`),
          ...keysOf(relations["joinedBy"]).map((name) => `${JOINDERS}${name}`),
        ]
      : []),
  ];
};

export const COURTLISTENER_SOURCE_FIELD_INVENTORY = {
  status: "declared",
  fields: Object.fromEntries([
    ...PART_FIELDS.flatMap(([part, prefix, fields]) =>
      prefixed({
        prefix,
        part,
        rowPath: prefix.includes("[]") ? ["*"] : [],
        fields,
      }),
    ),
    ...prefixed({
      prefix: PEOPLE,
      part: COURTLISTENER_RAW_PART.JUDGE_RELATIONS,
      rowPath: ["people", "*"],
      fields: PERSON_FIELDS,
    }),
    ...prefixed({
      prefix: JOINDERS,
      part: COURTLISTENER_RAW_PART.JUDGE_RELATIONS,
      rowPath: ["joinedBy", "*"],
      fields: { opinionId: JUDGES, personId: JUDGES },
    }),
  ]),
  listSourceFields,
} as const satisfies SourceFieldInventory;

/**
 * What the publisher serves for one cluster. The bulk tables are the admitted
 * edition; renderings and live responses of the same rows are not a second
 * source for them.
 */
const SOURCE_SURFACES = [
  "bulk-opinion-cluster",
  "bulk-docket",
  "bulk-court",
  "bulk-opinions",
  "bulk-citations",
  "judge-relations",
  "case-page",
  "rest-api",
  "citation-map",
  "opinion-binaries",
  "scan-renditions",
] as const;

export const COURTLISTENER_SOURCE_SURFACES = {
  surfaces: {
    "bulk-opinion-cluster": storedSourceSurface(COURTLISTENER_RAW_PART.CLUSTER),
    "bulk-docket": storedSourceSurface(COURTLISTENER_RAW_PART.DOCKET),
    "bulk-court": storedSourceSurface(COURTLISTENER_RAW_PART.COURT),
    "bulk-opinions": storedSourceSurface(COURTLISTENER_RAW_PART.OPINIONS),
    "bulk-citations": storedSourceSurface(COURTLISTENER_RAW_PART.CITATIONS),
    "judge-relations": storedSourceSurface(
      COURTLISTENER_RAW_PART.JUDGE_RELATIONS,
    ),
    "case-page": excludedSourceSurface(
      "HTML rendering of the cluster, docket, opinion and citation rows stored",
    ),
    "rest-api": excludedSourceSurface(
      "live responses are another, mutable edition; one pinned edition is admitted",
    ),
    "citation-map": excludedSourceSurface(
      "corpus-wide graph between opinions, not the cluster's own citations",
    ),
    "opinion-binaries": excludedSourceSurface(
      "documents behind download_url and local_path; text that needs them is held",
    ),
    "scan-renditions": excludedSourceSurface(
      "scan PDFs and page images; a scan-only record is held for its assets",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;
