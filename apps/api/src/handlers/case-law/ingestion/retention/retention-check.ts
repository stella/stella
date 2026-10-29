import { panic, Result } from "better-result";

import { type Block, hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
  type RetentionTextAbsence,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { errorTag } from "@/api/lib/errors/error-tag";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import {
  validateAndLog,
  type ValidationSourcePolicy,
  type ValidationSubject,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { logger } from "@/api/lib/observability/logger";

/** A parsed decision whose retention the pipeline could not measure. */
export const RETENTION_UNVERIFIABLE = "case_law.retention.unverifiable";

/**
 * A parsed decision the check knowingly left unmeasured: its source keeps
 * the text in a document the check cannot read from the stored raw, the
 * document is over the projection's budget, or too many checks were already
 * running. Expected and counted, so it is an info line, not an error.
 */
export const RETENTION_UNCHECKED = "case_law.retention.unchecked";

/** Why a parsed decision's retention went unmeasured. */
export const RETENTION_UNVERIFIABLE_REASON = {
  /** A source declared unparsed nevertheless built a document. */
  UNPARSED_SOURCE_BUILT_DOCUMENT: "unparsed-source-built-document",
  /** The decision carries no stored raw to project. */
  NO_SOURCE_RAW: "no-source-raw",
  /** The projection read the raw and declared it unreadable. */
  PROJECTION_FAILED: "projection-failed",
  /** The publisher served no text, yet the parser built a document. */
  DOCUMENT_WITHOUT_PUBLISHER_TEXT: "document-without-publisher-text",
  /**
   * The projection, the oracle or a report threw. The check is telemetry,
   * so the failure is reported here and never reaches the decision write.
   */
  CHECK_FAILED: "check-failed",
} as const;

type RetentionUnverifiableReason =
  (typeof RETENTION_UNVERIFIABLE_REASON)[keyof typeof RETENTION_UNVERIFIABLE_REASON];

/** Why a check was never started, beside the projections' own reasons. */
export const RETENTION_CHECK_BACKLOG = "check-backlog";

/**
 * How many checks may run at once. A check holds its decision's raw and
 * blocks until it ends, and the writes it follows can outpace it, so past
 * this a decision is reported unchecked instead of queued without bound.
 */
export const MAX_RETENTION_CHECKS_IN_FLIGHT = 4;

/** The document a retention signal names, without the parser that built it. */
type RetentionSubject = Omit<ValidationSubject, "parser">;

const reportUnverifiable = (
  subject: ValidationSubject,
  reason: RetentionUnverifiableReason,
  detail: Readonly<Record<string, string>> = {},
): void => {
  logger.error(RETENTION_UNVERIFIABLE, { ...subject, reason, ...detail });
};

/**
 * Text kept in a separately stored document, or in one over the
 * projection's budget, is a known blind spot stated per record by its
 * projection; text the publisher never served while the parser still built
 * a document is a defect.
 */
const reportTextAbsence = (
  subject: ValidationSubject,
  absence: RetentionTextAbsence,
): void => {
  switch (absence) {
    case RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT:
    case RETENTION_TEXT_ABSENCE.OVER_CHECK_BUDGET:
      logger.info(RETENTION_UNCHECKED, { ...subject, reason: absence });
      return;
    case RETENTION_TEXT_ABSENCE.NOT_PUBLISHED:
      reportUnverifiable(
        subject,
        RETENTION_UNVERIFIABLE_REASON.DOCUMENT_WITHOUT_PUBLISHER_TEXT,
        { absence },
      );
      return;
    default:
      absence satisfies never;
      return panic(`Unhandled retention text absence: ${String(absence)}`);
  }
};

const reportProjection = (
  subject: ValidationSubject,
  projection: RetentionProjection,
  blocks: Block[],
  sourcePolicy: ValidationSourcePolicy | undefined,
): void => {
  switch (projection.type) {
    case "unreadable":
      reportUnverifiable(
        subject,
        RETENTION_UNVERIFIABLE_REASON.PROJECTION_FAILED,
        { failure: projection.reason },
      );
      return;
    case "no-text":
      reportTextAbsence(subject, projection.reason);
      return;
    case "source":
      validateAndLog(subject, projection.source, blocks, {
        ...projection.options,
        ...(sourcePolicy === undefined ? {} : { sourcePolicy }),
      });
      return;
    default:
      projection satisfies never;
      return panic(
        `Unhandled retention projection: ${JSON.stringify(projection)}`,
      );
  }
};

/**
 * Run one check behind the only boundary it has. Everything it does, the
 * projection, the oracle and every report, happens inside, so the returned
 * promise never rejects. A failure is reported once as unverifiable; when
 * reporting is itself what failed (a log sink that throws), that report
 * fails too and is dropped behind its own boundary, because the check is
 * telemetry and nothing it does may reach the write it follows.
 */
const settleCheck = async (
  subject: ValidationSubject,
  check: () => Promise<void>,
): Promise<void> => {
  const checked = await Result.tryPromise({
    try: check,
    catch: (cause) => cause,
  });
  if (Result.isOk(checked)) {
    return;
  }
  Result.try({
    try: () => {
      reportUnverifiable(subject, RETENTION_UNVERIFIABLE_REASON.CHECK_FAILED, {
        errorTag: errorTag(checked.error),
      });
    },
    catch: (cause) => cause,
  }).unwrapOr(undefined);
};

type CheckProjectedRetentionOptions = {
  /** The source's adapter key, which names the parser in every signal. */
  adapterKey: string;
  subject: RetentionSubject;
  /**
   * The source's projection of what its publisher served, run inside the
   * check so a projection that throws is reported like one that rejects.
   */
  project: () => Promise<RetentionProjection>;
  /** The blocks the parser built from that same publisher text. */
  blocks: Block[];
  /** How the oracle reads this source's text on both sides, if it differs. */
  sourcePolicy?: ValidationSourcePolicy | undefined;
};

/**
 * Compare parsed blocks against a projection of the publisher's text and
 * report loss through the oracle's own signals. Never rejects.
 *
 * Shared by every writer of parsed documents: the pipeline for each
 * decision it writes, and any drain that stores a parsed document outside
 * it.
 */
export const checkProjectedRetention = async ({
  adapterKey,
  subject,
  project,
  blocks,
  sourcePolicy,
}: CheckProjectedRetentionOptions): Promise<void> => {
  const named: ValidationSubject = { parser: adapterKey, ...subject };
  await settleCheck(named, async () => {
    reportProjection(named, await project(), blocks, sourcePolicy);
  });
};

type CheckDecisionRetentionOptions = {
  /** The source's adapter key, which names the parser in every signal. */
  adapterKey: string;
  policy: RetentionPolicy;
  result: IngestionResult;
  sourcePolicy?: ValidationSourcePolicy | undefined;
};

const decisionSubject = (
  adapterKey: string,
  result: IngestionResult,
): ValidationSubject => ({
  parser: adapterKey,
  caseNumber: result.caseNumber,
  language: result.language,
  url: result.sourceUrl ?? result.documentUrl,
});

const runDecisionRetention = async ({
  adapterKey,
  policy,
  result,
  sourcePolicy,
}: CheckDecisionRetentionOptions): Promise<void> => {
  const ast = result.documentAst;
  if (!hasUsableAst(ast)) {
    return;
  }
  const named = decisionSubject(adapterKey, result);
  switch (policy.type) {
    case "unparsed":
      reportUnverifiable(
        named,
        RETENTION_UNVERIFIABLE_REASON.UNPARSED_SOURCE_BUILT_DOCUMENT,
        { unparsedReason: policy.reason },
      );
      return;
    case "checked":
      break;
    default:
      policy satisfies never;
      return panic(`Unhandled retention policy: ${JSON.stringify(policy)}`);
  }
  const sourceRaw = result.sourceRaw;
  if (sourceRaw === undefined) {
    reportUnverifiable(named, RETENTION_UNVERIFIABLE_REASON.NO_SOURCE_RAW);
    return;
  }
  reportProjection(
    named,
    await policy.project(sourceRaw),
    ast.blocks,
    sourcePolicy,
  );
};

/**
 * Compare a parsed decision against its source's projection of the
 * publisher's text, and report loss through the oracle's own signals.
 * Never rejects: every branch, its reports included, runs behind one
 * boundary.
 *
 * Telemetry only: a decision that fails the check is still stored, because
 * dropping a decision for losing some of its text would lose all of it. The
 * signal is what an operator sweeps for, and re-parsing from `sourceRaw`
 * after the parser is fixed is the remedy.
 *
 * Every state that leaves the decision unmeasured is reported too, so a
 * source cannot pass this check by never reaching it.
 */
export const checkDecisionRetention = async (
  options: CheckDecisionRetentionOptions,
): Promise<void> => {
  await settleCheck(
    decisionSubject(options.adapterKey, options.result),
    async () => {
      await runDecisionRetention(options);
    },
  );
};

const inFlight = new Set<Promise<void>>();

/**
 * Start a check off the caller's path and return its promise, which never
 * rejects; a writer hands it to `detached` and goes on. The check begins on
 * a later turn; PDF projections parse in the shared PDF subprocess. No
 * abort signal or deadline of the write reaches the check.
 */
const startCheck = async (
  subject: ValidationSubject,
  check: () => Promise<void>,
): Promise<void> => {
  if (inFlight.size >= MAX_RETENTION_CHECKS_IN_FLIGHT) {
    return settleCheck(subject, async () => {
      logger.info(RETENTION_UNCHECKED, {
        ...subject,
        reason: RETENTION_CHECK_BACKLOG,
      });
      await Promise.resolve();
    });
  }
  const run = async (): Promise<void> => {
    await Bun.sleep(0);
    await check();
  };
  const tracked: Promise<void> = run().finally(() => {
    inFlight.delete(tracked);
  });
  inFlight.add(tracked);
  return tracked;
};

/** `checkDecisionRetention`, started off the write that stored the decision. */
export const startDecisionRetentionCheck = async (
  options: CheckDecisionRetentionOptions,
): Promise<void> =>
  startCheck(decisionSubject(options.adapterKey, options.result), async () => {
    await checkDecisionRetention(options);
  });

/** `checkProjectedRetention`, started off the store it follows. */
export const startProjectedRetentionCheck = async (
  options: CheckProjectedRetentionOptions,
): Promise<void> =>
  startCheck({ parser: options.adapterKey, ...options.subject }, async () => {
    await checkProjectedRetention(options);
  });

/**
 * Resolves once every check started so far has ended: for a test asserting
 * on what a write's check reported, or a worker finishing before it exits.
 */
export const settleRetentionChecks = async (): Promise<void> => {
  await Promise.all(inFlight);
};
