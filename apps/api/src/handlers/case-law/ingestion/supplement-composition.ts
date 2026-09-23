/**
 * How a decision's document takes in the supplements that belong to it.
 *
 * SAOS publishes the written reasons of a ruling as a document of its own.
 * They belong inside the ruling's document: a reader opens one decision and
 * reads the ruling and its reasons, a search finds the ruling by a phrase in
 * its reasons, and a citation the reasons make is the ruling's citation.
 * Most rulings SAOS serves already carry their reasons inline; this is the
 * same shape for the ones whose reasons were published apart.
 *
 * The judgment's own observation never carries its supplements, so every
 * write of it composes them again from `case_law_decision_supplements`: the
 * composed document is a function of the observation and the stored
 * supplements, and its hash covers both, so an unchanged pair is a fixed
 * point and a changed supplement moves the hash the refresh check reads.
 */

import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisionSupplements, caseLawDecisions } from "@/api/db/schema";
import type {
  Block,
  DocumentAst,
  ParagraphBlock,
} from "@/api/handlers/case-law/document-ast";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type {
  DecisionSupplementTarget,
  EmptyAst,
  IngestionResult,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { SafeId } from "@/api/lib/branded-types";
import { supplementAnchorPrefix } from "@/api/lib/case-law/decision-absorption";
import type { DecisionSupplementKind } from "@/api/lib/legal-search/decision-supplement-kind";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";

/**
 * The metadata key a composed decision lists its supplements under: which
 * publisher documents its text was composed from, so a reader of the row can
 * tell the reasons were published apart and find them at the publisher.
 */
export const DOCUMENT_SUPPLEMENTS_METADATA_KEY = "documentSupplements";

/** A ruling a supplement could belong to. */
export type SupplementJudgmentCandidate = {
  decisionDate: string | null;
  decisionType: string | null;
};

export type SupplementJudgmentSelection<TCandidate> =
  | { type: "judgment"; judgment: TCandidate }
  | { type: "none" }
  | { type: "ambiguous"; candidates: readonly TCandidate[] };

type SelectSupplementJudgmentOptions<TCandidate> = {
  target: DecisionSupplementTarget;
  candidates: readonly TCandidate[];
};

/**
 * The ruling a supplement belongs to, among the decisions under its court
 * and docket.
 *
 * A candidate must carry one of the target's decision types and, where the
 * supplement is dated, a date at or before it: reasons are written on or
 * after the ruling they explain. Of those, the latest-dated one is the
 * judgment, because a docket that holds several rulings (an order, then the
 * judgment) is explained by reasons dated after the last of them.
 *
 * Refuses to guess. Two candidates on the latest date, an undated candidate
 * beside others, or an undated supplement over several candidates are all
 * `ambiguous`: attaching reasons to the wrong ruling publishes them under a
 * decision they do not explain, and parking them loses nothing.
 */
export const selectSupplementJudgment = <
  TCandidate extends SupplementJudgmentCandidate,
>({
  target: { decisionTypes, latestDecisionDate },
  candidates,
}: SelectSupplementJudgmentOptions<TCandidate>): SupplementJudgmentSelection<TCandidate> => {
  const eligible = candidates.filter(
    ({ decisionDate, decisionType }) =>
      decisionType !== null &&
      decisionTypes.includes(decisionType) &&
      (decisionDate === null ||
        latestDecisionDate === undefined ||
        decisionDate <= latestDecisionDate),
  );
  const [only, ...others] = eligible;
  if (only === undefined) {
    return { type: "none" };
  }
  if (others.length === 0) {
    return { type: "judgment", judgment: only };
  }
  if (
    latestDecisionDate === undefined ||
    eligible.some(({ decisionDate }) => decisionDate === null)
  ) {
    return { type: "ambiguous", candidates: eligible };
  }
  // ISO dates order lexicographically; every eligible date is non-null here.
  let latest = "";
  for (const { decisionDate } of eligible) {
    if (decisionDate !== null && decisionDate > latest) {
      latest = decisionDate;
    }
  }
  const onLatest = eligible.filter(
    ({ decisionDate }) => decisionDate === latest,
  );
  const [judgment, ...tied] = onLatest;
  if (judgment === undefined || tied.length > 0) {
    return { type: "ambiguous", candidates: onLatest };
  }
  return { type: "judgment", judgment };
};

/** One supplement as stored, with what composing it needs. */
export type StoredSupplement = {
  sourceDocumentId: string;
  kind: DecisionSupplementKind;
  fulltext: string | null;
  documentAst: DocumentAst | EmptyAst;
  sourceHash: string;
  sourceUrl: string | null;
};

/** The court, docket and language a supplement shares with its judgment. */
export type SupplementTargetKey = {
  sourceId: SafeId<"caseLawSource">;
  court: string;
  caseNumber: string;
  language: string;
};

/**
 * Serializes the two writers of one docket's supplements: the supplement's
 * own ingest, which decides between parking and merging, and a judgment's
 * write, which checks that what it composed is still what belongs to it.
 * Taken first in both transactions, so neither can wait on the other while
 * holding anything the other needs.
 */
export const lockSupplementTarget = async (
  tx: Transaction,
  { sourceId, court, caseNumber, language }: SupplementTargetKey,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('case_law_decision_supplement'), hashtext(${`${sourceId}:${court}:${caseNumber}:${language}`}))`,
  );
};

const STORED_SUPPLEMENT_COLUMNS = {
  sourceDocumentId: caseLawDecisionSupplements.sourceDocumentId,
  kind: caseLawDecisionSupplements.kind,
  fulltext: caseLawDecisionSupplements.fulltext,
  documentAst: caseLawDecisionSupplements.documentAst,
  sourceHash: caseLawDecisionSupplements.sourceHash,
  sourceUrl: caseLawDecisionSupplements.sourceUrl,
  latestDecisionDate: caseLawDecisionSupplements.latestDecisionDate,
  judgmentDecisionTypes: caseLawDecisionSupplements.judgmentDecisionTypes,
  decisionId: caseLawDecisionSupplements.decisionId,
} as const;

type SupplementCandidateRow = StoredSupplement & {
  latestDecisionDate: string | null;
  judgmentDecisionTypes: string[];
  decisionId: SafeId<"caseLawDecision"> | null;
};

/**
 * The most rows one docket is read for. A docket holds a ruling or two and
 * their reasons; the bound keeps a malformed docket from turning a crawl's
 * per-decision probe into a scan.
 */
const DOCKET_ROW_LIMIT = 100;

/** The supplements stored under a docket, whatever they are attached to. */
export const selectSupplementsUnder = async (
  tx: Transaction,
  key: SupplementTargetKey,
): Promise<SupplementCandidateRow[]> =>
  await tx
    .select(STORED_SUPPLEMENT_COLUMNS)
    .from(caseLawDecisionSupplements)
    .where(
      and(
        eq(caseLawDecisionSupplements.sourceId, key.sourceId),
        eq(caseLawDecisionSupplements.court, key.court),
        eq(caseLawDecisionSupplements.caseNumber, key.caseNumber),
        eq(caseLawDecisionSupplements.language, key.language),
      ),
    )
    // Composed in id order, so the same supplements compose the same text.
    .orderBy(caseLawDecisionSupplements.sourceDocumentId)
    .limit(DOCKET_ROW_LIMIT);

type SupplementRuling = SupplementJudgmentCandidate & {
  id: SafeId<"caseLawDecision">;
  redacted: boolean;
};

type SelectRulingsUnderOptions = {
  key: SupplementTargetKey;
  decisionTypes: readonly string[];
};

/**
 * The stored decisions under a docket that a supplement could belong to.
 * Unordered: `selectSupplementJudgment` does not depend on the order.
 */
export const selectRulingsUnder = async (
  tx: Transaction,
  { key, decisionTypes }: SelectRulingsUnderOptions,
): Promise<SupplementRuling[]> => {
  if (decisionTypes.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      id: caseLawDecisions.id,
      decisionDate: caseLawDecisions.decisionDate,
      decisionType: caseLawDecisions.decisionType,
      redactedAt: caseLawDecisions.redactedAt,
    })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, key.sourceId),
        eq(caseLawDecisions.caseNumber, key.caseNumber),
        eq(caseLawDecisions.court, key.court),
        eq(caseLawDecisions.language, key.language),
        inArray(caseLawDecisions.decisionType, [...decisionTypes]),
      ),
    )
    .limit(DOCKET_ROW_LIMIT);
  return rows.map(({ id, decisionDate, decisionType, redactedAt }) => ({
    id,
    decisionDate,
    decisionType,
    redacted: redactedAt !== null,
  }));
};

type SelectComposableSupplementsOptions = {
  key: SupplementTargetKey;
  /** The row the judgment is stored under, or the id it is about to take. */
  decisionId: SafeId<"caseLawDecision">;
  judgment: SupplementJudgmentCandidate;
};

/** Marks the judgment being written among the stored rulings. */
const INCOMING_JUDGMENT = Symbol("incoming-judgment");

/**
 * The supplements a judgment's document is composed from.
 *
 * Every supplement already merged into this judgment stays with it, and a
 * parked one joins it when the judgment, as this write states it, is the
 * one `selectSupplementJudgment` picks among the docket's rulings. A
 * supplement merged into another decision stays there: moving it would
 * leave its text in that decision's stored document.
 */
export const selectComposableSupplements = async (
  tx: Transaction,
  { key, decisionId, judgment }: SelectComposableSupplementsOptions,
): Promise<StoredSupplement[]> => {
  const supplements = await selectSupplementsUnder(tx, key);
  if (supplements.length === 0) {
    return [];
  }
  const decisionTypes = [
    ...new Set(supplements.flatMap((row) => row.judgmentDecisionTypes)),
  ];
  const others = (await selectRulingsUnder(tx, { key, decisionTypes })).filter(
    ({ id }) => id !== decisionId,
  );
  const candidates: {
    marker: SafeId<"caseLawDecision"> | typeof INCOMING_JUDGMENT;
    decisionDate: string | null;
    decisionType: string | null;
  }[] = others.map(({ id, decisionDate, decisionType }) => ({
    marker: id,
    decisionDate,
    decisionType,
  }));
  candidates.push({
    marker: INCOMING_JUDGMENT,
    decisionDate: judgment.decisionDate,
    decisionType: judgment.decisionType,
  });
  return supplements
    .filter((row) => {
      if (row.decisionId !== null) {
        return row.decisionId === decisionId;
      }
      const selection = selectSupplementJudgment({
        target: {
          decisionTypes: row.judgmentDecisionTypes,
          latestDecisionDate: row.latestDecisionDate ?? undefined,
        },
        candidates,
      });
      return (
        selection.type === "judgment" &&
        selection.judgment.marker === INCOMING_JUDGMENT
      );
    })
    .map(
      ({
        sourceDocumentId,
        kind,
        fulltext,
        documentAst,
        sourceHash,
        sourceUrl,
      }) => ({
        sourceDocumentId,
        kind,
        fulltext,
        documentAst,
        sourceHash,
        sourceUrl,
      }),
    );
};

/** What composing one observation takes in, and under which docket. */
export type SupplementCompositionPlan = {
  key: SupplementTargetKey;
  judgment: SupplementJudgmentCandidate;
  supplements: StoredSupplement[];
};

type PlanSupplementCompositionOptions = {
  sourceId: SafeId<"caseLawSource">;
  /** The row the observation is stored under, or the id it is about to take. */
  decisionId: SafeId<"caseLawDecision">;
  observation: IngestionResult;
};

/**
 * The supplements an observation's write composes, or `null` where the
 * observation cannot hold one: without a publisher id its row cannot be told
 * from the docket's other rows, and without a document of its own there is
 * nothing to compose into, so its supplements stay parked until one arrives.
 */
export const planSupplementComposition = async (
  tx: Transaction,
  { sourceId, decisionId, observation }: PlanSupplementCompositionOptions,
): Promise<SupplementCompositionPlan | null> => {
  if (
    observation.sourceDocumentId === undefined ||
    !(Boolean(observation.fulltext) || hasUsableAst(observation.documentAst))
  ) {
    return null;
  }
  const key = {
    sourceId,
    court: observation.court,
    caseNumber: observation.caseNumber,
    language: observation.language,
  };
  const judgment = {
    decisionDate: observation.decisionDate ?? null,
    decisionType: observation.decisionType ?? null,
  };
  const supplements = await selectComposableSupplements(tx, {
    key,
    decisionId,
    judgment,
  });
  return { key, judgment, supplements };
};

/**
 * The observation as its write would compose it. For a caller that compares
 * a rebuilt observation with the stored row, as a replay does: the row holds
 * the composed document, so the observation alone always reads as changed.
 */
export const composeWithStoredSupplements = async ({
  scopedDb,
  ...options
}: PlanSupplementCompositionOptions & {
  scopedDb: ScopedDb;
}): Promise<IngestionResult> =>
  composeDecisionWithSupplements(
    options.observation,
    (await scopedDb(async (tx) => await planSupplementComposition(tx, options)))
      ?.supplements ?? [],
  );

/** Whether two compositions took in the same versions of the same supplements. */
export const sameSupplementVersions = (
  left: readonly StoredSupplement[],
  right: readonly StoredSupplement[],
): boolean =>
  left.length === right.length &&
  left.every((supplement, index) => {
    const other = right.at(index);
    return (
      other !== undefined &&
      supplement.sourceDocumentId === other.sourceDocumentId &&
      supplement.sourceHash === other.sourceHash
    );
  });

type MarkSupplementsMergedOptions = {
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  supplements: readonly StoredSupplement[];
};

/**
 * Record that this judgment's stored document now holds these supplement
 * versions. Written in the transaction that writes the judgment, after the
 * docket lock confirmed the composition still stands.
 */
export const markSupplementsMerged = async (
  tx: Transaction,
  { sourceId, decisionId, supplements }: MarkSupplementsMergedOptions,
): Promise<void> => {
  if (supplements.length === 0) {
    return;
  }
  // The versions are the current ones: the caller compared them under the
  // docket lock this transaction holds.
  // audit: skip — background case-law ingestion; public case-law data
  await tx
    .update(caseLawDecisionSupplements)
    .set({
      decisionId,
      mergedSourceHash: sql`${caseLawDecisionSupplements.sourceHash}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(caseLawDecisionSupplements.sourceId, sourceId),
        inArray(
          caseLawDecisionSupplements.sourceDocumentId,
          supplements.map(({ sourceDocumentId }) => sourceDocumentId),
        ),
      ),
    );
};

/**
 * A supplement's blocks, addressable beside the judgment's own.
 *
 * Both documents number their blocks from one, so each id, anchor and note
 * id takes the supplement's prefix; an anchor into the judgment still
 * resolves exactly. The supplement's title becomes a section heading: the
 * composed document has one title, the judgment's.
 */
const supplementBlocks = (supplement: StoredSupplement): Block[] => {
  const prefix = supplementAnchorPrefix(supplement);
  if (!hasUsableAst(supplement.documentAst)) {
    return paragraphsOf(supplement, prefix);
  }
  return supplement.documentAst.blocks.map((block): Block => {
    switch (block.type) {
      case "heading":
        return {
          ...block,
          id: `${prefix}${block.id}`,
          anchorId: `${prefix}${block.anchorId}`,
          ...(block.role === "decision-title"
            ? { role: "section-heading" }
            : {}),
        };
      case "paragraph":
        return {
          ...block,
          id: `${prefix}${block.id}`,
          anchorId: `${prefix}${block.anchorId}`,
          ...(block.note?.noteId === undefined
            ? {}
            : {
                note: {
                  ...block.note,
                  noteId: `${prefix}${block.note.noteId}`,
                },
              }),
        };
      case "table":
      case "image":
        return {
          ...block,
          id: `${prefix}${block.id}`,
          anchorId: `${prefix}${block.anchorId}`,
        };
      default: {
        block satisfies never;
        return panic(`Unhandled block: ${JSON.stringify(block)}`);
      }
    }
  });
};

/**
 * Paragraphs for a supplement whose parser produced no structure: its text
 * still has to reach the composed document, a paragraph per blank-line run.
 */
const paragraphsOf = (
  { fulltext }: StoredSupplement,
  prefix: string,
): ParagraphBlock[] =>
  (fulltext ?? "")
    .split(/\n\s*\n/u)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text, index) => ({
      id: `${prefix}t${index + 1}`,
      anchorId: `${prefix}p-${index + 1}`,
      type: "paragraph",
      inlines: [{ type: "text", text }],
      plainText: text,
    }));

const compositeHash = (
  judgment: IngestionResult,
  supplements: readonly StoredSupplement[],
): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify({
      judgment: judgment.rawHash,
      supplements: supplements.map(({ sourceDocumentId, sourceHash }) => [
        sourceDocumentId,
        sourceHash,
      ]),
    }),
  );
  return hasher.digest("hex");
};

/**
 * The judgment's observation with its supplements taken in: the text and
 * the blocks appended in id order, the sections derived over the whole, and
 * a hash over the observation and every supplement version.
 *
 * Pure, so the same inputs compose the same document on every write.
 */
export const composeDecisionWithSupplements = (
  judgment: IngestionResult,
  supplements: readonly StoredSupplement[],
): IngestionResult => {
  if (supplements.length === 0) {
    return judgment;
  }
  const fulltext = [judgment.fulltext, ...supplements.map((s) => s.fulltext)]
    .map((text) => text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n");
  const documentAst = hasUsableAst(judgment.documentAst)
    ? {
        ...judgment.documentAst,
        blocks: [
          ...judgment.documentAst.blocks,
          ...supplements.flatMap((supplement) => supplementBlocks(supplement)),
        ],
      }
    : judgment.documentAst;
  const ownSections = judgment.sections;
  const sections =
    ownSections === undefined
      ? undefined
      : [
          ...ownSections,
          ...supplements
            .flatMap((supplement) => segmentDecision(supplement.fulltext ?? ""))
            .map(({ type, title, text }, offset) => ({
              index: ownSections.length + offset,
              type,
              title,
              text,
            })),
        ];
  return {
    ...judgment,
    fulltext: fulltext.length > 0 ? fulltext : undefined,
    documentAst,
    sections,
    rawHash: compositeHash(judgment, supplements),
    metadata: {
      ...judgment.metadata,
      [DOCUMENT_SUPPLEMENTS_METADATA_KEY]: supplements.map(
        ({ kind, sourceDocumentId, sourceUrl }) => ({
          kind,
          sourceDocumentId,
          ...(sourceUrl === null ? {} : { sourceUrl }),
        }),
      ),
    },
  };
};
