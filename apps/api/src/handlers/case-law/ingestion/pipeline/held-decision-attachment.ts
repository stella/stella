import { panic, Result } from "better-result";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { sanitizeErrorForOutput } from "@stll/errors";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
} from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawHeldDecisionAttachments,
  caseLawSources,
} from "@/api/db/schema";
import { normalizeDecisionIdentifierIn } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  lockSourceIdentitiesTx,
  type ObservedDecision,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
  type ProcessResult,
  wrappedErrorDetail,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { writeOwnedRawPayload } from "@/api/handlers/case-law/ingestion/pipeline/raw-payload";
import {
  type AttemptStep,
  RECONCILE_CONTENTION,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import { ecliPublisherSpellings } from "@/api/lib/case-law/ecli-spellings";
import { replayWrite } from "@/api/lib/case-law/replay-write";
import { republishedRulingCourtPredicate } from "@/api/lib/case-law/ruling-identity-match";
import { lockCaseLawDecisionRows } from "@/api/lib/db/aggregate-lock";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { errorSystemFields } from "@/api/lib/errors/utils";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import type { HeldDecisionAttachment } from "@/api/lib/legal-search/held-decision-attachment";
import {
  HELD_DECISION_AMBIGUOUS_CANDIDATES_MAX,
  HELD_DECISION_ATTACHMENT_STATUS,
  HELD_DECISION_MATCH_BASIS,
  type HeldDecisionDeclaredIdentifier,
  type HeldDecisionMatchBasis,
} from "@/api/lib/legal-search/held-decision-attachment-values";
import type { RawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";
import type { S3CredentialRefreshOptions } from "@/api/lib/s3/credential-guard";
import { sortDeep } from "@/api/lib/sort-deep";

/** A record attached to, or refreshed on, the held decision it names. */
export const HELD_DECISION_ATTACHED =
  "case_law.ingestion.held_decision_attached";

/**
 * Several held decisions match a record, so it is parked with no row of its
 * own: an operator reads the candidates off its attachment row.
 */
export const HELD_DECISION_AMBIGUOUS =
  "case_law.ingestion.held_decision_ambiguous";

/** A record's host was erased or redacted, so the record is parked. */
export const HELD_DECISION_WITHDRAWN =
  "case_law.ingestion.held_decision_withdrawn";

/** What became of one record of a declaring source. */
export type HeldDecisionAttachmentDisposition =
  | {
      type: "attached";
      hostDecisionId: SafeId<"caseLawDecision">;
      basis: HeldDecisionMatchBasis;
    }
  /** Already attached in this version, or a later observation is stored. */
  | { type: "unchanged"; hostDecisionId: SafeId<"caseLawDecision"> }
  | { type: "stale" }
  | {
      type: "ambiguous";
      basis: HeldDecisionMatchBasis;
      candidateDecisionIds: SafeId<"caseLawDecision">[];
    }
  | { type: "withdrawn"; hostDecisionId: SafeId<"caseLawDecision"> };

/**
 * The attach step's answer: write the record as a decision of its own, or
 * the attempt's outcome, settled here.
 */
export type HeldDecisionAttachmentStep =
  | { type: "own-row" }
  | {
      type: "settled";
      step: AttemptStep;
      disposition: HeldDecisionAttachmentDisposition | null;
    };

type HostDecision = {
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  redactedAt: Date | null;
};

type HostMatch =
  | { type: "none" }
  | { type: "one"; basis: HeldDecisionMatchBasis; host: HostDecision }
  | {
      type: "several";
      basis: HeldDecisionMatchBasis;
      candidateDecisionIds: SafeId<"caseLawDecision">[];
    };

type StoredAttachment = typeof caseLawHeldDecisionAttachments.$inferSelect;

export type AttachToHeldDecisionOptions = {
  declaration: HeldDecisionAttachment<string>;
  observation: ObservedDecision;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  observationOrder: bigint;
  /**
   * Opened before the read that proves the host is not erased, so the raw
   * write under the host's prefix starts within the window of that read.
   */
  rawWindow: RawSourceWriteWindow;
  signal?: AbortSignal;
  s3Policy?: S3CredentialRefreshOptions;
};

const COMPLETE: ProcessResult = {
  status: PROCESS_DECISION_STATUS.COMPLETE,
  inserted: false,
  searchVectorFailed: false,
};

const settled = (
  disposition: HeldDecisionAttachmentDisposition | null,
  step: AttemptStep = COMPLETE,
): HeldDecisionAttachmentStep => ({ type: "settled", step, disposition });

const hostSourceIdsSql = (
  declaration: HeldDecisionAttachment<string>,
  sourceId: SafeId<"caseLawSource">,
) =>
  sql`(SELECT ${caseLawSources.id} FROM ${caseLawSources}
    WHERE ${inArray(caseLawSources.adapterKey, [...declaration.hostAdapterKeys])}
      AND ${ne(caseLawSources.id, sourceId)})`;

const HOST_COLUMNS = {
  id: caseLawDecisions.id,
  sourceId: caseLawDecisions.sourceId,
  redactedAt: caseLawDecisions.redactedAt,
};

/**
 * The held decisions the record names: by its stated ECLI where any host
 * decision carries it as an identifier, otherwise by court, docket and
 * decision date. A redacted host still matches: the takedown covers the
 * record too, which is the caller's to settle.
 */
const matchHostDecisionsTx = async (
  tx: Transaction,
  {
    declaration,
    observation: { observed, persistedDecisionDate },
    sourceId,
  }: Pick<
    AttachToHeldDecisionOptions,
    "declaration" | "observation" | "sourceId"
  >,
): Promise<HostMatch> => {
  const hostSources = hostSourceIdsSql(declaration, sourceId);
  const limit = HELD_DECISION_AMBIGUOUS_CANDIDATES_MAX;
  const answer = (
    basis: HeldDecisionMatchBasis,
    hosts: readonly HostDecision[],
  ): HostMatch => {
    const [first, second] = hosts;
    if (first === undefined) {
      return { type: "none" };
    }
    return second === undefined
      ? { type: "one", basis, host: first }
      : {
          type: "several",
          basis,
          candidateDecisionIds: hosts.map(({ id }) => id),
        };
  };
  // Every spelling of the stated ECLI another publisher of the decision
  // may hold it under, each read as the identifier index stores it.
  const ecliKeys =
    observed.ecli === undefined
      ? []
      : [
          ...new Set(
            ecliPublisherSpellings(observed.country, observed.ecli).map(
              (value) =>
                normalizeDecisionIdentifierIn(observed.country, {
                  type: DECISION_IDENTIFIER_TYPES.ECLI,
                  value,
                }),
            ),
          ),
        ].filter((key) => key.length > 0);
  if (ecliKeys.length > 0) {
    const byEcli = await tx
      .selectDistinct(HOST_COLUMNS)
      .from(caseLawDecisionIdentifiers)
      .innerJoin(
        caseLawDecisions,
        eq(caseLawDecisions.id, caseLawDecisionIdentifiers.decisionId),
      )
      .where(
        and(
          eq(caseLawDecisionIdentifiers.type, DECISION_IDENTIFIER_TYPES.ECLI),
          inArray(caseLawDecisionIdentifiers.normalizedValue, ecliKeys),
          sql`${caseLawDecisions.sourceId} IN ${hostSources}`,
        ),
      )
      .orderBy(caseLawDecisions.id)
      .limit(limit);
    if (byEcli.length > 0) {
      return answer(HELD_DECISION_MATCH_BASIS.ECLI, byEcli);
    }
  }
  const decisionDate = persistedDecisionDate ?? undefined;
  if (decisionDate === undefined || observed.caseNumber.length === 0) {
    return { type: "none" };
  }
  const byDocket = await tx
    .select(HOST_COLUMNS)
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.caseNumber, observed.caseNumber),
        eq(caseLawDecisions.decisionDate, decisionDate),
        eq(caseLawDecisions.country, observed.country),
        sql`${caseLawDecisions.sourceId} IN ${hostSources}`,
        republishedRulingCourtPredicate(
          {
            // Typed, so the comparison's bare `IS NOT NULL` reads a text.
            court: sql`${observed.court}::text`,
            courtId:
              observed.courtId === undefined
                ? null
                : sql`${observed.courtId}::text`,
          },
          { court: caseLawDecisions.court, courtId: caseLawDecisions.courtId },
        ),
      ),
    )
    .orderBy(caseLawDecisions.id)
    .limit(limit);
  return answer(HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE, byDocket);
};

/** The host a stored attachment names, through any alias it was retired into. */
const readHostTx = async (
  tx: Transaction,
  hostDecisionId: SafeId<"caseLawDecision">,
): Promise<HostDecision | undefined> =>
  (
    await tx
      .select(HOST_COLUMNS)
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, canonicalDecisionIdSql(hostDecisionId)))
      .limit(1)
  ).at(0);

/** Whether the record already has a decision row of its own. */
const holdsOwnRowTx = async (
  tx: Transaction,
  {
    sourceId,
    observation: { exactSourceIdentityCandidates },
  }: Pick<AttachToHeldDecisionOptions, "sourceId" | "observation">,
): Promise<boolean> => {
  const reserved = await tx
    .select({ id: caseLawDecisionSourceIdentities.decisionId })
    .from(caseLawDecisionSourceIdentities)
    .where(
      and(
        eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
        inArray(
          caseLawDecisionSourceIdentities.sourceDocumentId,
          exactSourceIdentityCandidates,
        ),
      ),
    )
    .limit(1);
  if (reserved.length > 0) {
    return true;
  }
  const stored = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, sourceId),
        inArray(
          caseLawDecisions.sourceDocumentId,
          exactSourceIdentityCandidates,
        ),
      ),
    )
    .limit(1);
  return stored.length > 0;
};

const attachmentKey = (
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
) =>
  and(
    eq(caseLawHeldDecisionAttachments.sourceId, sourceId),
    eq(caseLawHeldDecisionAttachments.sourceDocumentId, sourceDocumentId),
  );

/**
 * The record's attachment row. Every ingestion writer of it holds the
 * record's publisher-identity locks, and the erasure that parks it holds its
 * host's row, which the write below locks as well.
 */
const readAttachmentTx = async (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
): Promise<StoredAttachment | undefined> =>
  (
    await tx
      .select()
      .from(caseLawHeldDecisionAttachments)
      .where(attachmentKey(sourceId, sourceDocumentId))
      .limit(1)
  ).at(0);

/**
 * Park an attachment whose host is gone or redacted. Its metadata and raw
 * pointer go with the takedown; the raw object itself lives under the host's
 * prefix and goes with the host's sweep.
 */
const parkWithdrawnTx = async (
  tx: Transaction,
  stored: StoredAttachment,
  host: HostDecision | undefined,
): Promise<HeldDecisionAttachmentDisposition> => {
  const hostDecisionId = host?.id ?? stored.hostDecisionId;
  if (hostDecisionId === null) {
    return panic("A parked withdrawn attachment needs its host");
  }
  // audit: skip — background case-law ingestion; public case-law data
  const write = replayWrite(
    caseLawHeldDecisionAttachments,
    {
      status: HELD_DECISION_ATTACHMENT_STATUS.HOST_WITHDRAWN,
      hostDecisionId,
      metadata: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
    },
    {
      modifiedAt: {
        column: caseLawHeldDecisionAttachments.updatedAt,
        value: new Date(),
      },
    },
  );
  await tx
    .update(caseLawHeldDecisionAttachments)
    .set(write.set)
    .where(
      and(
        attachmentKey(stored.sourceId, stored.sourceDocumentId),
        write.setWhere,
      ),
    );
  logger.warn(HELD_DECISION_WITHDRAWN, {
    sourceId: stored.sourceId,
    sourceDocumentId: stored.sourceDocumentId,
    hostDecisionId,
  });
  return { type: "withdrawn", hostDecisionId };
};

/** What the first transaction decided for the record. */
type AttachmentPlan =
  | { type: "settled"; step: HeldDecisionAttachmentStep }
  | {
      type: "attach";
      host: HostDecision;
      basis: HeldDecisionMatchBasis;
      stored: StoredAttachment | undefined;
    };

const readTypedMetadata = (
  declaration: HeldDecisionAttachment<string>,
  observed: ObservedDecision["observed"],
): Result<
  Readonly<Record<string, unknown>>,
  UnpersistableDecisionFieldError
> => {
  const parsed = v.safeParse(
    declaration.metadataSchema,
    observed.metadata[declaration.metadataKey],
  );
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new UnpersistableDecisionFieldError({
          message: `Held-decision attachment metadata does not match its schema: ${v.summarize(parsed.issues).slice(0, 200)}`,
          field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
        }),
      );
};

/** The identifier rows the record declares on its host, in a stable order. */
const declaredIdentifiersOf = (
  declaration: HeldDecisionAttachment<string>,
  observed: ObservedDecision["observed"],
): HeldDecisionDeclaredIdentifier[] => {
  const types = new Set<string>(declaration.declaredIdentifierTypes);
  const byKey = new Map<string, HeldDecisionDeclaredIdentifier>();
  for (const identifier of observed.identifiers ?? []) {
    if (!types.has(identifier.type)) {
      continue;
    }
    const normalizedValue = normalizeDecisionIdentifierIn(
      observed.country,
      identifier,
    );
    if (normalizedValue.length === 0) {
      continue;
    }
    byKey.set(`${identifier.type}\u0000${normalizedValue}`, {
      type: identifier.type,
      value: identifier.value,
      normalizedValue,
    });
  }
  return [...byKey.entries()]
    .toSorted(([left], [right]) => compareCodeUnit(left, right))
    .map(([, identifier]) => identifier);
};

const identifierKey = ({
  type,
  normalizedValue,
}: HeldDecisionDeclaredIdentifier) => `${type}\u0000${normalizedValue}`;

type PlanAttachmentOptions = AttachToHeldDecisionOptions & {
  sourceDocumentId: string;
  metadata: Readonly<Record<string, unknown>>;
};

/**
 * Decide, under the record's identity locks, whether it is its own decision,
 * already settled, parked, or to be attached to one host.
 */
const planAttachmentTx = async (
  tx: Transaction,
  options: PlanAttachmentOptions,
): Promise<AttachmentPlan> => {
  const {
    sourceId,
    sourceDocumentId,
    observation,
    observationOrder,
    observedAt,
    metadata,
  } = options;
  await lockSourceIdentitiesTx(
    tx,
    sourceId,
    observation.sourceIdentityCandidates,
  );
  // A record that has a row of its own stays one: it never flips onto a
  // host a later observation could name.
  if (await holdsOwnRowTx(tx, options)) {
    return { type: "settled", step: { type: "own-row" } };
  }
  const stored = await readAttachmentTx(tx, sourceId, sourceDocumentId);
  if (stored?.status === HELD_DECISION_ATTACHMENT_STATUS.HOST_WITHDRAWN) {
    const { hostDecisionId } = stored;
    return {
      type: "settled",
      step: settled(
        hostDecisionId === null ? null : { type: "withdrawn", hostDecisionId },
      ),
    };
  }
  if (stored !== undefined && stored.observationOrder >= observationOrder) {
    return { type: "settled", step: settled({ type: "stale" }) };
  }
  if (stored?.status === HELD_DECISION_ATTACHMENT_STATUS.ATTACHED) {
    const hostDecisionId =
      stored.hostDecisionId ?? panic("An attached record names no host");
    const host = await readHostTx(tx, hostDecisionId);
    if (host === undefined || host.redactedAt !== null) {
      return {
        type: "settled",
        step: settled(await parkWithdrawnTx(tx, stored, host)),
      };
    }
    // The host stays the one first matched: a changed record refreshes its
    // attachment and never moves to another decision.
    return {
      type: "attach",
      host,
      basis: stored.matchBasis,
      stored,
    };
  }
  const match = await matchHostDecisionsTx(tx, options);
  switch (match.type) {
    case "none": {
      if (stored !== undefined) {
        // A record parked as ambiguous whose candidates are gone is a
        // decision of its own now.
        // audit: skip — background case-law ingestion; public case-law data
        await tx
          .delete(caseLawHeldDecisionAttachments)
          .where(attachmentKey(sourceId, sourceDocumentId));
      }
      return { type: "settled", step: { type: "own-row" } };
    }
    case "several": {
      const parked = {
        status: HELD_DECISION_ATTACHMENT_STATUS.AMBIGUOUS,
        matchBasis: match.basis,
        hostDecisionId: null,
        candidateDecisionIds: match.candidateDecisionIds,
        metadata: { ...metadata },
        declaredIdentifiers: [],
        sourceUrl: observation.observed.sourceUrl ?? null,
        sourceHash: observation.observed.rawHash,
        sourceRawS3Key: null,
        sourceRawContentType: null,
        observedAt,
        observationOrder,
      };
      const write = replayWrite(caseLawHeldDecisionAttachments, parked, {
        modifiedAt: {
          column: caseLawHeldDecisionAttachments.updatedAt,
          value: new Date(),
        },
      });
      // audit: skip — background case-law ingestion; public case-law data
      await tx
        .insert(caseLawHeldDecisionAttachments)
        .values({ sourceId, sourceDocumentId, ...parked })
        .onConflictDoUpdate({
          target: [
            caseLawHeldDecisionAttachments.sourceId,
            caseLawHeldDecisionAttachments.sourceDocumentId,
          ],
          set: write.set,
          setWhere: write.setWhere,
        });
      logger.warn(HELD_DECISION_AMBIGUOUS, {
        sourceId,
        sourceDocumentId,
        basis: match.basis,
        candidates: match.candidateDecisionIds.length,
      });
      return {
        type: "settled",
        step: settled({
          type: "ambiguous",
          basis: match.basis,
          candidateDecisionIds: match.candidateDecisionIds,
        }),
      };
    }
    case "one": {
      if (match.host.redactedAt !== null) {
        // A takedown covers every publisher's copy of the decision: record
        // that this one belongs to it, and keep nothing of it.
        const withdrawn = {
          status: HELD_DECISION_ATTACHMENT_STATUS.HOST_WITHDRAWN,
          matchBasis: match.basis,
          hostDecisionId: match.host.id,
          candidateDecisionIds: [],
          metadata: null,
          declaredIdentifiers: [],
          sourceUrl: observation.observed.sourceUrl ?? null,
          sourceHash: observation.observed.rawHash,
          sourceRawS3Key: null,
          sourceRawContentType: null,
          observedAt,
          observationOrder,
        };
        const write = replayWrite(caseLawHeldDecisionAttachments, withdrawn, {
          modifiedAt: {
            column: caseLawHeldDecisionAttachments.updatedAt,
            value: new Date(),
          },
        });
        // audit: skip — background case-law ingestion; public case-law data
        await tx
          .insert(caseLawHeldDecisionAttachments)
          .values({ sourceId, sourceDocumentId, ...withdrawn })
          .onConflictDoUpdate({
            target: [
              caseLawHeldDecisionAttachments.sourceId,
              caseLawHeldDecisionAttachments.sourceDocumentId,
            ],
            set: write.set,
            setWhere: write.setWhere,
          });
        logger.warn(HELD_DECISION_WITHDRAWN, {
          sourceId,
          sourceDocumentId,
          hostDecisionId: match.host.id,
        });
        return {
          type: "settled",
          step: settled({ type: "withdrawn", hostDecisionId: match.host.id }),
        };
      }
      return { type: "attach", host: match.host, basis: match.basis, stored };
    }
    default:
      match satisfies never;
      return panic(`Unhandled host match: ${String(match)}`);
  }
};

type WriteAttachmentOptions = PlanAttachmentOptions & {
  host: HostDecision;
  basis: HeldDecisionMatchBasis;
  /** The attachment state the plan read; a different one is contention. */
  planned: StoredAttachment | undefined;
  raw: { key: string | null; contentType: string | null };
  declared: HeldDecisionDeclaredIdentifier[];
};

type AttachmentWrite =
  | { type: "written" }
  | { type: "contention" }
  | { type: "too-many-identifiers" };

/**
 * Write the attachment and its declared identifiers, with the host's
 * projection, under the record's identity locks and a lock on the host
 * row: an erasure that takes the host after this commits sees the attachment
 * and parks it, and one that took it before leaves this write nothing to
 * attach to.
 */
const writeAttachmentTx = async (
  tx: Transaction,
  {
    sourceId,
    sourceDocumentId,
    observation,
    observationOrder,
    observedAt,
    metadata,
    host,
    basis,
    planned,
    raw,
    declared,
  }: WriteAttachmentOptions,
): Promise<AttachmentWrite> => {
  await lockSourceIdentitiesTx(
    tx,
    sourceId,
    observation.sourceIdentityCandidates,
  );
  // Source lock before the row lock, the order every decision writer and
  // the erasure take them in.
  const projectionLock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
    family: "case_law",
    sourceId: host.sourceId,
  });
  await lockCaseLawDecisionRows({ tx, decisionIds: [host.id] });
  const liveHost = (
    await tx
      .select({ redactedAt: caseLawDecisions.redactedAt })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, host.id))
      .limit(1)
  ).at(0);
  const current = await readAttachmentTx(tx, sourceId, sourceDocumentId);
  if (
    liveHost === undefined ||
    liveHost.redactedAt !== null ||
    current?.observationOrder !== planned?.observationOrder ||
    current?.status !== planned?.status
  ) {
    return { type: "contention" };
  }
  const previous = current?.declaredIdentifiers ?? [];
  const incoming = new Set(declared.map(identifierKey));
  const withdrawn = previous.filter(
    (identifier) => !incoming.has(identifierKey(identifier)),
  );
  const hostIdentifiers = await tx
    .select({
      type: caseLawDecisionIdentifiers.type,
      normalizedValue: caseLawDecisionIdentifiers.normalizedValue,
    })
    .from(caseLawDecisionIdentifiers)
    .where(eq(caseLawDecisionIdentifiers.decisionId, host.id));
  const held = new Set(
    hostIdentifiers.map((identifier) =>
      identifierKey({ ...identifier, value: "" }),
    ),
  );
  const added = declared.filter(
    (identifier) => !held.has(identifierKey(identifier)),
  );
  if (hostIdentifiers.length + added.length > DECISION_IDENTIFIER_MAX_COUNT) {
    return { type: "too-many-identifiers" };
  }

  const values = {
    status: HELD_DECISION_ATTACHMENT_STATUS.ATTACHED,
    matchBasis: basis,
    hostDecisionId: host.id,
    candidateDecisionIds: [],
    metadata: { ...metadata },
    declaredIdentifiers: declared,
    sourceUrl: observation.observed.sourceUrl ?? null,
    sourceHash: observation.observed.rawHash,
    sourceRawS3Key: raw.key,
    sourceRawContentType: raw.contentType,
    observedAt,
    observationOrder,
  };
  const write = replayWrite(caseLawHeldDecisionAttachments, values, {
    modifiedAt: {
      column: caseLawHeldDecisionAttachments.updatedAt,
      value: new Date(),
    },
  });
  // audit: skip — background case-law ingestion; public case-law data
  await tx
    .insert(caseLawHeldDecisionAttachments)
    .values({ sourceId, sourceDocumentId, ...values })
    .onConflictDoUpdate({
      target: [
        caseLawHeldDecisionAttachments.sourceId,
        caseLawHeldDecisionAttachments.sourceDocumentId,
      ],
      set: write.set,
      setWhere: write.setWhere,
    });

  // An identifier this record no longer states leaves the host, unless the
  // host derives it itself or another record still declares it.
  for (const identifier of withdrawn) {
    // db-await-in-loop: a record declares a handful of identifiers at most
    // audit: skip — background case-law ingestion; public case-law data
    await tx.delete(caseLawDecisionIdentifiers).where(
      and(
        eq(caseLawDecisionIdentifiers.decisionId, host.id),
        eq(caseLawDecisionIdentifiers.type, identifier.type),
        eq(
          caseLawDecisionIdentifiers.normalizedValue,
          identifier.normalizedValue,
        ),
        isNotNull(caseLawDecisionIdentifiers.declaredAt),
        sql`NOT EXISTS (SELECT 1 FROM ${caseLawHeldDecisionAttachments} other
          WHERE other.host_decision_id = ${host.id}
            AND other.status = ${HELD_DECISION_ATTACHMENT_STATUS.ATTACHED}
            AND NOT (other.source_id = ${sourceId} AND other.source_document_id = ${sourceDocumentId})
            AND other.declared_identifiers @> ${JSON.stringify([
              {
                type: identifier.type,
                normalizedValue: identifier.normalizedValue,
              },
            ])}::text::jsonb)`,
      ),
    );
  }
  if (declared.length > 0) {
    // A declared identifier survives every refresh of the host. One the
    // host already derives keeps its spelling and is declared as well, so
    // the host ceasing to state it does not take it away from this record.
    const declareWrite = replayWrite(caseLawDecisionIdentifiers, {
      declaredAt: sql`coalesce(${caseLawDecisionIdentifiers.declaredAt}, excluded.declared_at)`,
    });
    // audit: skip — background case-law ingestion; public case-law data
    await tx
      .insert(caseLawDecisionIdentifiers)
      .values(
        declared.map(({ type, value, normalizedValue }) => ({
          decisionId: host.id,
          type,
          value,
          normalizedValue,
          declaredAt: observedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          caseLawDecisionIdentifiers.decisionId,
          caseLawDecisionIdentifiers.type,
          caseLawDecisionIdentifiers.normalizedValue,
        ],
        ...declareWrite,
      });
  }
  // The search document is built from the host's identifiers.
  if (projectionLock !== null && (added.length > 0 || withdrawn.length > 0)) {
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock: projectionLock,
      subject: { family: "case_law", entityId: host.id },
    });
  }
  return { type: "written" };
};

/**
 * The write-time step of a source that declares `HeldDecisionAttachment`:
 * attach the record to the one held decision it names, park it when several
 * or a withdrawn one match, or hand it back to be written as a decision of
 * its own. Replays are a fixed point: an unchanged or older observation of
 * an attached record writes nothing.
 */
export const attachToHeldDecision = async (
  options: AttachToHeldDecisionOptions,
): Promise<
  Result<HeldDecisionAttachmentStep, UnpersistableDecisionFieldError>
> => {
  const { declaration, observation, sourceId, scopedDb, signal, s3Policy } =
    options;
  const { observed } = observation;
  const sourceDocumentId = observed.sourceDocumentId;
  if (sourceDocumentId === undefined || sourceDocumentId.length === 0) {
    // Nothing to key an attachment by: the record's own identity path
    // decides it, as for any other source.
    return Result.ok({ type: "own-row" });
  }
  const metadata = readTypedMetadata(declaration, observed);
  if (Result.isError(metadata)) {
    return metadata;
  }
  const planOptions: PlanAttachmentOptions = {
    ...options,
    sourceDocumentId,
    metadata: metadata.value,
  };
  const plan = await scopedDb(
    async (tx) => await planAttachmentTx(tx, planOptions),
  );
  if (plan.type === "settled") {
    return Result.ok(plan.step);
  }
  const { host, basis, stored } = plan;
  const declared = declaredIdentifiersOf(declaration, observed);
  if (
    stored !== undefined &&
    stored.sourceHash === observed.rawHash &&
    JSON.stringify(sortDeep(stored.declaredIdentifiers)) ===
      JSON.stringify(sortDeep(declared)) &&
    JSON.stringify(sortDeep(stored.metadata)) ===
      JSON.stringify(sortDeep(metadata.value))
  ) {
    return Result.ok(settled({ type: "unchanged", hostDecisionId: host.id }));
  }

  signal?.throwIfAborted();
  const contentType = observed.sourceRawContentType ?? "text/plain";
  const rawWrite = await Result.tryPromise({
    try: async () =>
      await writeOwnedRawPayload({
        ...(signal === undefined ? {} : { signal }),
        ...(s3Policy === undefined ? {} : { s3Policy }),
        result: observed,
        // The record is a copy of the host decision: its payload lives under
        // the host's prefix, so erasing the decision erases every copy.
        sourceId: host.sourceId,
        ownerId: host.id,
        contentType,
        storedKey: stored?.sourceRawS3Key ?? null,
        storedContentType: stored?.sourceRawContentType ?? null,
        window: options.rawWindow,
      }),
    catch: (cause) => cause,
  });
  const raw = rawWrite.andThen((written) => written);
  if (Result.isError(raw)) {
    signal?.throwIfAborted();
    logger.error("case_law.ingestion.held_decision_raw_write_failed", {
      sourceId,
      hostDecisionId: host.id,
      ...errorSystemFields(raw.error),
      "error.detail": wrappedErrorDetail(sanitizeErrorForOutput(raw.error)),
    });
    return Result.ok(
      settled(null, {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: false,
        reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
      }),
    );
  }
  const rawKey = raw.value ?? null;

  signal?.throwIfAborted();
  const written = await scopedDb(
    async (tx) =>
      await writeAttachmentTx(tx, {
        ...planOptions,
        host,
        basis,
        planned: stored,
        raw: {
          key: rawKey,
          contentType: rawKey === null ? null : contentType,
        },
        declared,
      }),
  );
  switch (written.type) {
    case "contention":
      return Result.ok(settled(null, RECONCILE_CONTENTION));
    case "too-many-identifiers":
      return Result.err(
        new UnpersistableDecisionFieldError({
          message: `Declaring these identifiers would give the held decision more than ${DECISION_IDENTIFIER_MAX_COUNT}`,
          field: UNPERSISTABLE_DECISION_FIELDS.IDENTIFIER_COUNT,
        }),
      );
    case "written":
      break;
    default:
      written satisfies never;
      return panic(`Unhandled attachment write: ${String(written)}`);
  }
  logger.info(HELD_DECISION_ATTACHED, {
    sourceId,
    sourceDocumentId,
    hostDecisionId: host.id,
    basis,
  });
  return Result.ok(
    settled({ type: "attached", hostDecisionId: host.id, basis }),
  );
};
