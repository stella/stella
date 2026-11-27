import { panic } from "better-result";

import {
  type DocumentAst,
  headMatterOrderDegradations,
  type PersistedAstDegradation,
  persistedAstDegradations,
} from "@stll/legal-ast/document-ast";
import type { EmptyAst } from "@stll/legal-ast/document-types";

import { StoredAstDegradedError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import {
  type FailureMeasures,
  observeFailure,
} from "@/api/lib/observability/observe-failure";

/**
 * What one read of a stored document AST came to, beside the AST it served.
 *
 * The persisted reader never refuses vocabulary it does not declare and
 * never drops text: it keeps what it cannot read as written in a neutral
 * shape (`persistedAstDegradations`). That leaves a row served correctly but
 * not as written, and a row needing a reparse must not be invisible, so every
 * read names its outcome:
 *
 * - `read`: the AST as written.
 * - `absent`: the row stores no AST.
 * - `structureless`: the row stores the empty AST, the corpus's value for a
 *   document whose structure ingestion did not keep (a source without a
 *   structural parser, a metadata-first row whose document has not been
 *   delivered, a structure that failed the writer's contract beside usable
 *   text). The text payload, when there is one, is all a reader gets.
 * - `degraded`: served without loss but not as written; `counts` holds the
 *   degradations per kind and `vocabulary` the stored names behind them.
 *
 * A stored AST the reader cannot read at all is not an outcome here: it
 * raises `StoredCorpusValidationError`, which has its own reporter, and a
 * caller that recovers from it records `unreadable` (see
 * `StoredAstOutcome`).
 */
export type StoredAstReadOutcome =
  | { readonly type: "read" }
  | { readonly type: "absent" }
  | { readonly type: "structureless" }
  | {
      readonly type: "degraded";
      readonly counts: StoredAstDegradationCounts;
      readonly vocabulary: readonly string[];
    };

/** A read outcome, or the typed refusal a recovering caller settled for. */
export type StoredAstOutcome =
  | StoredAstReadOutcome
  | { readonly type: "unreadable"; readonly reason: "stored_ast_invalid" };

export type StoredAstDegradationKind = PersistedAstDegradation["kind"];

/** Total over the degradation kinds, so a kind added is a type error here. */
type StoredAstDegradationCounts = Readonly<
  Record<StoredAstDegradationKind, number>
>;

/** A list of kinds that type-checks only while it names every kind. */
const everyKind = <const TKinds extends readonly StoredAstDegradationKind[]>(
  kinds: TKinds &
    ([Exclude<StoredAstDegradationKind, TKinds[number]>] extends [never]
      ? unknown
      : never),
): TKinds => kinds;

/** The kinds in a stable order, for counters that iterate them. */
const STORED_AST_DEGRADATION_KINDS = everyKind([
  "block-type",
  "block-role",
  "inline-type",
  "block-identity",
  "head-matter-order",
]);

const zeroCounts = (): Record<StoredAstDegradationKind, number> => ({
  "block-type": 0,
  "block-role": 0,
  "inline-type": 0,
  "block-identity": 0,
  "head-matter-order": 0,
});

/**
 * A stored vocabulary name as a record may carry it. Parser vocabulary is
 * kebab-case identifiers; anything else is stored data that is not one, and
 * is named by its kind alone.
 */
const VOCABULARY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u;

const UNNAMED = "unnamed";

/** Distinct names one outcome keeps; a row carrying more is named by these. */
const MAX_VOCABULARY = 8;

const vocabularyName = (name: string): string =>
  VOCABULARY_NAME.test(name) ? name : UNNAMED;

const vocabularyOf = (
  degradation: PersistedAstDegradation,
): string | undefined => {
  switch (degradation.kind) {
    case "block-type":
    case "inline-type":
      return `${degradation.kind}:${vocabularyName(degradation.type)}`;
    case "block-role":
      return `block-role:${degradation.type}/${vocabularyName(degradation.role)}`;
    case "block-identity":
    case "head-matter-order":
      return undefined;
    default:
      degradation satisfies never;
      return panic(`Unhandled AST degradation: ${String(degradation)}`);
  }
};

const isEmptyAst = (ast: DocumentAst | EmptyAst): ast is EmptyAst =>
  !("blocks" in ast);

/**
 * The outcome of one read, from the raw stored value and the AST the
 * persisted reader made of it. Pure: reporting is `reportStoredAstOutcome`.
 */
export const storedAstReadOutcome = (
  raw: unknown,
  ast: DocumentAst | EmptyAst | null,
): StoredAstReadOutcome => {
  if (ast === null) {
    return { type: "absent" };
  }
  if (isEmptyAst(ast)) {
    return { type: "structureless" };
  }
  const degradations = [
    ...persistedAstDegradations(raw),
    ...headMatterOrderDegradations(ast.blocks),
  ];
  if (degradations.length === 0) {
    return { type: "read" };
  }
  const counts = zeroCounts();
  const vocabulary = new Set<string>();
  for (const degradation of degradations) {
    counts[degradation.kind] += 1;
    const name = vocabularyOf(degradation);
    if (name !== undefined && vocabulary.size < MAX_VOCABULARY) {
      vocabulary.add(name);
    }
  }
  return { type: "degraded", counts, vocabulary: [...vocabulary].toSorted() };
};

/**
 * One record per read of a row the reader served other than as written,
 * graded `stored_ast_degraded` (anticipated): the data needs a reparse, no
 * code is at fault, and a reparse is asked for by the document id this
 * carries.
 */
const STORED_AST_DEGRADED_SINK = failureSink({
  event: "case_law.stored_ast_degraded",
  expected: [],
});

const MEASURE_OF_KIND = {
  "block-type": "astBlockType",
  "block-role": "astBlockRole",
  "inline-type": "astInlineType",
  "block-identity": "astBlockIdentity",
  "head-matter-order": "astHeadMatterOrder",
} as const satisfies Record<StoredAstDegradationKind, keyof FailureMeasures>;

/** The longest vocabulary list a record carries, within the context bound. */
const MAX_VOCABULARY_CHARS = 128;

const vocabularyField = (vocabulary: readonly string[]): string => {
  let field = "";
  for (const name of vocabulary) {
    const next = field === "" ? name : `${field},${name}`;
    if (next.length > MAX_VOCABULARY_CHARS) {
      break;
    }
    field = next;
  }
  return field;
};

export type StoredAstReportContext = {
  /** The document the AST belongs to, when the caller knows it. */
  readonly documentId?: string | undefined;
  readonly jurisdiction?: string | undefined;
  readonly parserVersion?: number | undefined;
};

/**
 * Report one read's outcome: nothing for a read as written or no AST, one
 * WARN record for a degraded or structureless one. Never carries document
 * content: the counts are integers and the vocabulary is parser identifiers.
 */
export const reportStoredAstOutcome = (
  outcome: StoredAstReadOutcome,
  { documentId, jurisdiction, parserVersion }: StoredAstReportContext = {},
): void => {
  if (outcome.type === "read" || outcome.type === "absent") {
    return;
  }
  const counted =
    outcome.type === "degraded"
      ? STORED_AST_DEGRADATION_KINDS.flatMap((kind) =>
          outcome.counts[kind] > 0
            ? [[MEASURE_OF_KIND[kind], outcome.counts[kind]] as const]
            : [],
        )
      : [];
  const measures: FailureMeasures = Object.fromEntries([
    ...counted,
    ...(parserVersion === undefined
      ? []
      : [["parserVersion", parserVersion] as const]),
  ]);
  const vocabulary =
    outcome.type === "degraded" ? vocabularyField(outcome.vocabulary) : "";
  observeFailure(
    new StoredAstDegradedError({
      message: "Stored document AST was not read as written",
      outcome: outcome.type,
    }),
    {
      sink: STORED_AST_DEGRADED_SINK,
      ctx: {
        outcome: outcome.type,
        ...(documentId === undefined ? {} : { documentId }),
        ...(jurisdiction === undefined ? {} : { jurisdiction }),
        ...(vocabulary === "" ? {} : { vocabulary }),
      },
      measures,
    },
  );
};

/**
 * Documents a run read, per stored-AST outcome other than as written: what a
 * run's result carries so a degraded, structureless or unreadable AST never
 * passes it silently. A degraded document counts once in `degraded` and once
 * per kind it carries in `degradedByKind`.
 */
export type StoredAstReadCounts = {
  degraded: number;
  degradedByKind: Record<StoredAstDegradationKind, number>;
  structureless: number;
  unreadable: number;
};

export const emptyStoredAstReadCounts = (): StoredAstReadCounts => ({
  degraded: 0,
  degradedByKind: zeroCounts(),
  structureless: 0,
  unreadable: 0,
});

export const countStoredAstOutcome = (
  counts: StoredAstReadCounts,
  outcome: StoredAstOutcome,
): void => {
  switch (outcome.type) {
    case "read":
    case "absent":
      return;
    case "structureless":
      counts.structureless += 1;
      return;
    case "unreadable":
      counts.unreadable += 1;
      return;
    case "degraded":
      counts.degraded += 1;
      for (const kind of STORED_AST_DEGRADATION_KINDS) {
        if (outcome.counts[kind] > 0) {
          counts.degradedByKind[kind] += 1;
        }
      }
      return;
    default:
      outcome satisfies never;
      return panic(`Unhandled stored AST outcome: ${String(outcome)}`);
  }
};

/** One document's read outcome, for a caller keeping a per-document record. */
export type StoredAstDocumentOutcome = {
  readonly documentId: string;
  readonly jurisdiction: string;
  readonly outcome: StoredAstOutcome;
};
