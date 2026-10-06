// parser-output-unchanged: The SHA-256 owner receives identical UTF-8 inputs and emits the same lowercase hexadecimal digests; adapter fixture and fingerprint vectors retain the output.
import { panic, Result } from "better-result";
/**
 * The CourtListener record contract: one cluster with every row of the pinned
 * snapshot that belongs to it, as the loader assembles it.
 *
 * Admission is whole-cluster. The shape is validated before any publisher
 * value is read, then the typed readings (IDs, booleans, types), then the
 * joins and completeness the loader claims. Any failure rejects the cluster
 * with one reason; nothing is truncated, defaulted or partially accepted.
 */
import * as v from "valibot";

import { sha256Hex as hashContent } from "@stll/sha256/bun";

import { isoCalendarDay } from "@/api/lib/dates";
import { isRecord } from "@/api/lib/type-guards";

import {
  COURTLISTENER_REJECTION_REASON,
  type CourtListenerRecordRejectedError,
  type CourtListenerRejectionReason,
  rejectCourtListenerRecord,
  type RejectionDiagnostic,
} from "./rejection";
import {
  CITATION_COLUMNS,
  type CitationRow,
  CLUSTER_COLUMNS,
  columnDrift,
  COURT_COLUMNS,
  type CsvRow,
  DOCKET_COLUMNS,
  hasVisibleText,
  isCanonicalId,
  isCsvRow,
  isNullableDecimal,
  OPINION_COLUMNS,
  type OpinionRow,
  PERSON_COLUMNS,
  type PersonRow,
  readCsvBoolean,
} from "./snapshot-columns";
import {
  type CitationType,
  isCitationType,
  isOpinionType,
  type OpinionType,
} from "./vocabulary";

export const COURTLISTENER_RECORD_VERSION = 1;

/** Named bounds on one record. Past any of them the record is rejected whole. */
export const COURTLISTENER_RECORD_LIMITS = {
  RECORD_BYTES: 8 * 1024 * 1024,
  OPINIONS: 128,
  CITATIONS: 256,
  PEOPLE: 512,
  JOINDERS: 2048,
} as const;

const ROW_DRIFT = "row columns differ from the pinned snapshot header";

const csvRow = <TColumn extends string>(columns: readonly TColumn[]) =>
  v.custom<CsvRow<TColumn>>(isCsvRow(columns), ROW_DRIFT);

const canonicalId = v.pipe(
  v.string(),
  v.check(isCanonicalId, "not a canonical positive decimal ID"),
);
const statedText = v.pipe(v.string(), v.check(hasVisibleText, "blank"));

const courtListenerRecordSchema = v.strictObject({
  version: v.literal(COURTLISTENER_RECORD_VERSION),
  cluster: csvRow(CLUSTER_COLUMNS),
  docket: csvRow(DOCKET_COLUMNS),
  court: csvRow(COURT_COLUMNS),
  opinions: v.array(csvRow(OPINION_COLUMNS)),
  citations: v.array(csvRow(CITATION_COLUMNS)),
  // `unavailable` is not an empty relation: it says nothing about who wrote
  // or joined, where a complete relation with no joinders says nobody joined.
  judgeRelations: v.variant("status", [
    v.strictObject({ status: v.literal("unavailable") }),
    v.strictObject({
      status: v.literal("complete"),
      people: v.array(csvRow(PERSON_COLUMNS)),
      joinedBy: v.array(
        v.strictObject({ opinionId: canonicalId, personId: canonicalId }),
      ),
    }),
  ]),
  provenance: v.strictObject({
    snapshot: v.pipe(
      v.string(),
      v.check((day) => isoCalendarDay(day) === day, "not an ISO day"),
    ),
    artifacts: v.pipe(
      v.array(
        v.strictObject({
          table: statedText,
          url: statedText,
          etag: statedText,
        }),
      ),
      v.minLength(1),
    ),
    expectedOpinionIds: v.array(canonicalId),
    citationCoverage: v.literal("complete"),
  }),
});

export type CourtListenerRecordV1 = v.InferOutput<
  typeof courtListenerRecordSchema
>;

export type AdmittedOpinion = {
  readonly row: OpinionRow;
  readonly type: OpinionType;
  readonly perCuriam: boolean;
  readonly extractedByOcr: boolean;
};

export type AdmittedCitation = {
  readonly row: CitationRow;
  readonly type: CitationType;
};

/** A record that passed every check, with typed readings beside its rows. */
export type AdmittedCourtListenerRecord = {
  readonly record: CourtListenerRecordV1;
  readonly clusterId: string;
  readonly sourceRecordKey: string;
  readonly opinions: readonly AdmittedOpinion[];
  readonly citations: readonly AdmittedCitation[];
  /** Structured authorship, or `null` where the relation was not supplied. */
  readonly judgeRelations: {
    readonly people: ReadonlyMap<string, PersonRow>;
    readonly joinedBy: readonly { opinionId: string; personId: string }[];
  } | null;
  readonly dateFiledIsApproximate: boolean;
  readonly blocked: boolean;
};

type Check = {
  readonly ok: boolean;
  readonly path: string;
  readonly detail: string;
};

const idCheck = (path: string, value: string): Check => ({
  ok: isCanonicalId(value),
  path,
  detail: "not a canonical ID",
});
const booleanCheck = (path: string, value: string): Check => ({
  ok: readCsvBoolean(value) !== null,
  path,
  detail: "not t or f",
});

const completeRelations = ({ judgeRelations }: CourtListenerRecordV1) =>
  judgeRelations.status === "complete" ? judgeRelations : null;

const scalarChecks = (record: CourtListenerRecordV1): Check[] => {
  const { cluster, docket } = record;
  const relations = completeRelations(record);
  return [
    idCheck("cluster.id", cluster.id),
    idCheck("cluster.docket_id", cluster.docket_id),
    idCheck("docket.id", docket.id),
    {
      ok: hasVisibleText(docket.court_id),
      path: "docket.court_id",
      detail: "blank",
    },
    { ok: hasVisibleText(record.court.id), path: "court.id", detail: "blank" },
    booleanCheck(
      "cluster.date_filed_is_approximate",
      cluster.date_filed_is_approximate,
    ),
    booleanCheck("cluster.blocked", cluster.blocked),
    ...(
      ["scdb_votes_majority", "scdb_votes_minority", "citation_count"] as const
    ).map((column) => ({
      ok: isNullableDecimal(cluster[column]),
      path: `cluster.${column}`,
      detail: "not blank or decimal",
    })),
    ...record.opinions.flatMap((opinion, index) => [
      idCheck(`opinions.${index}.id`, opinion.id),
      idCheck(`opinions.${index}.cluster_id`, opinion.cluster_id),
      {
        ok: opinion.author_id === "" || isCanonicalId(opinion.author_id),
        path: `opinions.${index}.author_id`,
        detail: "not blank or a canonical ID",
      },
      booleanCheck(`opinions.${index}.per_curiam`, opinion.per_curiam),
      booleanCheck(
        `opinions.${index}.extracted_by_ocr`,
        opinion.extracted_by_ocr,
      ),
    ]),
    ...record.citations.flatMap((citation, index) => [
      idCheck(`citations.${index}.id`, citation.id),
      idCheck(`citations.${index}.cluster_id`, citation.cluster_id),
    ]),
    ...(relations === null
      ? []
      : relations.people.map((person, index) =>
          idCheck(`judgeRelations.people.${index}.id`, person.id),
        )),
  ];
};

const vocabularyChecks = (record: CourtListenerRecordV1): Check[] => [
  ...record.opinions.map((opinion, index) => ({
    ok: isOpinionType(opinion.type),
    path: `opinions.${index}.type`,
    detail: "undeclared opinion type",
  })),
  ...record.citations.map((citation, index) => ({
    ok: isCitationType(citation.type),
    path: `citations.${index}.type`,
    detail: "undeclared citation type",
  })),
];

const uniquenessChecks = (record: CourtListenerRecordV1): Check[] => {
  const relations = completeRelations(record);
  const sets = [
    ["opinions.id", record.opinions.map(({ id }) => id)],
    ["citations.id", record.citations.map(({ id }) => id)],
    ["provenance.expectedOpinionIds", record.provenance.expectedOpinionIds],
    ...(relations === null
      ? []
      : ([
          ["judgeRelations.people.id", relations.people.map(({ id }) => id)],
          [
            "judgeRelations.joinedBy",
            relations.joinedBy.map(
              (pair) => `${pair.opinionId}/${pair.personId}`,
            ),
          ],
        ] as const)),
  ] as const;
  return sets.flatMap(([path, values]) => {
    const seen = new Set<string>();
    return values.flatMap((value) => {
      const repeated = seen.has(value);
      seen.add(value);
      return repeated
        ? [{ ok: false, path, detail: `duplicate ${value}` }]
        : [];
    });
  });
};

const joinChecks = (record: CourtListenerRecordV1): Check[] => {
  const { cluster, docket } = record;
  const opinionIds = new Set(record.opinions.map(({ id }) => id));
  const expected = new Set(record.provenance.expectedOpinionIds);
  const relations = completeRelations(record);
  const personIds = new Set(relations?.people.map(({ id }) => id));
  const child =
    (table: string) => (row: { cluster_id: string }, index: number) => ({
      ok: row.cluster_id === cluster.id,
      path: `${table}.${index}.cluster_id`,
      detail: "belongs to another cluster",
    });
  return [
    { ok: opinionIds.size > 0, path: "opinions", detail: "no opinion rows" },
    {
      ok: cluster.docket_id === docket.id,
      path: "cluster.docket_id",
      detail: "does not name the docket row",
    },
    {
      ok: docket.court_id === record.court.id,
      path: "docket.court_id",
      detail: "does not name the court row",
    },
    ...record.opinions.map(child("opinions")),
    ...record.citations.map(child("citations")),
    ...[...opinionIds].map((id) => ({
      ok: expected.has(id),
      path: "provenance.expectedOpinionIds",
      detail: `opinion ${id} is outside the counted membership`,
    })),
    ...[...expected].map((id) => ({
      ok: opinionIds.has(id),
      path: "opinions",
      detail: `member opinion ${id} is missing`,
    })),
    ...(relations === null
      ? []
      : [
          ...record.opinions.map((opinion, index) => ({
            ok: opinion.author_id === "" || personIds.has(opinion.author_id),
            path: `opinions.${index}.author_id`,
            detail: "author is not among the supplied people",
          })),
          ...relations.joinedBy.flatMap(({ opinionId, personId }, index) => [
            {
              ok: opinionIds.has(opinionId),
              path: `judgeRelations.joinedBy.${index}.opinionId`,
              detail: "not an opinion of this cluster",
            },
            {
              ok: personIds.has(personId),
              path: `judgeRelations.joinedBy.${index}.personId`,
              detail: "not among the supplied people",
            },
          ]),
        ]),
  ];
};

const PHASES = [
  [COURTLISTENER_REJECTION_REASON.INVALID_RECORD, scalarChecks],
  [COURTLISTENER_REJECTION_REASON.SCHEMA_DRIFT, vocabularyChecks],
  [COURTLISTENER_REJECTION_REASON.INVALID_RECORD, uniquenessChecks],
  [COURTLISTENER_REJECTION_REASON.INCOMPLETE_CLUSTER, joinChecks],
] as const;

const lengthOf = (container: unknown, key: string): number => {
  const value = isRecord(container) ? container[key] : undefined;
  return Array.isArray(value) ? value.length : 0;
};

const limitDiagnostics = (
  input: unknown,
  bytes: number,
): RejectionDiagnostic[] => {
  const relations = isRecord(input) ? input["judgeRelations"] : undefined;
  const limits = COURTLISTENER_RECORD_LIMITS;
  return (
    [
      ["$", bytes, limits.RECORD_BYTES],
      ["opinions", lengthOf(input, "opinions"), limits.OPINIONS],
      ["citations", lengthOf(input, "citations"), limits.CITATIONS],
      ["judgeRelations.people", lengthOf(relations, "people"), limits.PEOPLE],
      [
        "judgeRelations.joinedBy",
        lengthOf(relations, "joinedBy"),
        limits.JOINDERS,
      ],
    ] as const
  ).flatMap(([path, size, limit]) =>
    size > limit
      ? [{ path, detail: `${size} exceeds the limit of ${limit}` }]
      : [],
  );
};

/** Every key the contract declares: the only keys a diagnostic path names. */
const DECLARED_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(courtListenerRecordSchema.entries),
  ...Object.keys(courtListenerRecordSchema.entries.provenance.entries),
  "table",
  "url",
  "etag",
  "status",
  "people",
  "joinedBy",
  "opinionId",
  "personId",
  ...CLUSTER_COLUMNS,
  ...DOCKET_COLUMNS,
  ...COURT_COLUMNS,
  ...OPINION_COLUMNS,
  ...CITATION_COLUMNS,
  ...PERSON_COLUMNS,
]);

/** Unexpected key names, as a count and a digest rather than the names. */
const unexpectedKeys = (keys: readonly string[]): string =>
  `${keys.length} unexpected key(s), sha256:${hashContent(keys.toSorted().join("\n")).slice(0, 16)}`;

/**
 * An issue's path in declared keys and indexes. A key the contract does not
 * declare is publisher input: it is replaced by `*` and reported only as a
 * count and digest, so no publisher-chosen name reaches a diagnostic.
 */
const trustedPath = (issue: v.BaseIssue<unknown>) => {
  const unexpected: string[] = [];
  const segments = issue.path?.map(({ key }) => {
    if (
      typeof key === "number" ||
      (typeof key === "string" && DECLARED_KEYS.has(key))
    ) {
      return String(key);
    }
    unexpected.push(String(key));
    return "*";
  });
  return { path: segments?.join(".") || "$", unexpected };
};

const ROW_TABLES: Readonly<Record<string, readonly string[]>> = {
  cluster: CLUSTER_COLUMNS,
  docket: DOCKET_COLUMNS,
  court: COURT_COLUMNS,
  opinions: OPINION_COLUMNS,
  citations: CITATION_COLUMNS,
  judgeRelations: PERSON_COLUMNS,
};

/**
 * Column drift is schema drift; any other shape failure is an invalid record,
 * described by what the schema expected. Valibot's own messages quote the
 * received value, which may be publisher text.
 */
const schemaDiagnostics = (
  issues: readonly v.BaseIssue<unknown>[],
): PhaseFailure => {
  const drift = issues.filter(({ message }) => message === ROW_DRIFT);
  if (drift.length === 0) {
    return {
      reason: COURTLISTENER_REJECTION_REASON.INVALID_RECORD,
      diagnostics: issues.map((issue) => {
        const { path, unexpected } = trustedPath(issue);
        if (unexpected.length > 0) {
          return { path, detail: unexpectedKeys(unexpected) };
        }
        return {
          path,
          detail:
            issue.type === "check"
              ? issue.message
              : `${issue.type}: expected ${issue.expected ?? "a declared value"}`,
        };
      }),
    };
  }
  const diagnostics: RejectionDiagnostic[] = [];
  for (const issue of drift) {
    const { path } = trustedPath(issue);
    const table = path.split(".").at(0);
    const columns = table === undefined ? undefined : ROW_TABLES[table];
    if (columns === undefined) {
      return panic(`No CourtListener row columns for ${path}`);
    }
    const { missing, notText, unexpected } = columnDrift(columns, issue.input);
    for (const column of missing) {
      diagnostics.push({ path: `${path}.${column}`, detail: "missing column" });
    }
    for (const column of notText) {
      diagnostics.push({
        path: `${path}.${column}`,
        detail: "value is not text",
      });
    }
    if (unexpected.length > 0) {
      diagnostics.push({ path, detail: unexpectedKeys(unexpected) });
    }
  }
  return { reason: COURTLISTENER_REJECTION_REASON.SCHEMA_DRIFT, diagnostics };
};

type PhaseFailure = {
  readonly reason: CourtListenerRejectionReason;
  readonly diagnostics: readonly RejectionDiagnostic[];
};

const serialize = (input: unknown): string | null => {
  const serialized: unknown = Result.try({
    try: (): unknown => JSON.stringify(input),
    catch: () => null,
  }).unwrapOr(null);
  return typeof serialized === "string" ? serialized : null;
};

const readableClusterId = (input: unknown): string | null => {
  const cluster = isRecord(input) ? input["cluster"] : undefined;
  const id = isRecord(cluster) ? cluster["id"] : undefined;
  return typeof id === "string" && isCanonicalId(id) ? id : null;
};

/** `cluster:<id>`, or a digest of the input where no cluster ID is readable. */
const recordKeyOf = (clusterId: string | null, serialized: string | null) => {
  if (clusterId !== null) {
    return `cluster:${clusterId}`;
  }
  return serialized === null
    ? "input:unserializable"
    : `input-sha256:${hashContent(serialized)}`;
};

const validate = (
  input: unknown,
  serialized: string | null,
): Result<CourtListenerRecordV1, PhaseFailure> => {
  if (serialized === null) {
    return Result.err({
      reason: COURTLISTENER_REJECTION_REASON.INVALID_RECORD,
      diagnostics: [{ path: "$", detail: "not JSON-serializable" }],
    });
  }
  const overLimit = limitDiagnostics(input, Buffer.byteLength(serialized));
  if (overLimit.length > 0) {
    return Result.err({
      reason: COURTLISTENER_REJECTION_REASON.OVER_LIMIT,
      diagnostics: overLimit,
    });
  }
  const parsed = v.safeParse(courtListenerRecordSchema, input);
  if (!parsed.success) {
    return Result.err(schemaDiagnostics(parsed.issues));
  }
  for (const [reason, checks] of PHASES) {
    const failed = checks(parsed.output).filter(({ ok }) => !ok);
    if (failed.length > 0) {
      return Result.err({
        reason,
        diagnostics: failed.map(({ detail, path }) => ({ detail, path })),
      });
    }
  }
  return Result.ok(parsed.output);
};

/**
 * Admit one record, or reject the cluster with the first failing phase's
 * reason and every diagnostic of that phase.
 */
export const admitCourtListenerRecord = (
  input: unknown,
): Result<AdmittedCourtListenerRecord, CourtListenerRecordRejectedError> => {
  const serialized = serialize(input);
  const clusterId = readableClusterId(input);
  const sourceRecordKey = recordKeyOf(clusterId, serialized);
  const validated = validate(input, serialized);
  if (Result.isError(validated)) {
    return Result.err(
      rejectCourtListenerRecord({
        ...validated.error,
        sourceRecordKey,
        clusterId,
      }),
    );
  }
  const record = validated.value;
  const relations = completeRelations(record);
  return Result.ok({
    record,
    clusterId: record.cluster.id,
    sourceRecordKey,
    opinions: record.opinions.flatMap((row) =>
      isOpinionType(row.type)
        ? [
            {
              row,
              type: row.type,
              perCuriam: readCsvBoolean(row.per_curiam) === true,
              extractedByOcr: readCsvBoolean(row.extracted_by_ocr) === true,
            },
          ]
        : [],
    ),
    citations: record.citations.flatMap((row) =>
      isCitationType(row.type) ? [{ row, type: row.type }] : [],
    ),
    judgeRelations:
      relations === null
        ? null
        : {
            people: new Map(
              relations.people.map((person) => [person.id, person]),
            ),
            joinedBy: relations.joinedBy,
          },
    dateFiledIsApproximate:
      readCsvBoolean(record.cluster.date_filed_is_approximate) === true,
    blocked: readCsvBoolean(record.cluster.blocked) === true,
  });
};
