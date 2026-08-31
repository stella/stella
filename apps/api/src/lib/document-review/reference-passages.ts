/**
 * Reference passages: the words a reference-derived position quotes.
 *
 * The text is persisted here and nowhere else. A position, a run basis, a
 * finding and a playbook carry a passage's id and provenance (which matter,
 * document, version and block it came from); the words are one row per
 * (version, block) in `document_review_reference_passages`, owned by the
 * matter the reference document belongs to and read under that matter's row
 * security. So a run in one matter never stores another matter's clauses, a
 * playbook shared across the organization never republishes them, and any
 * reader, on any surface, gets a quote exactly when their own transaction can
 * open the matter it came from.
 *
 * Two boundaries follow. Pinning (a run created from confirmed positions, a
 * playbook saved with reference positions) goes through the caller's scoped
 * transaction, so nobody can pin a passage they cannot read and have the
 * grader, which reads with service access, describe it back to them. Reading
 * text for display goes through the caller's scoped transaction as well;
 * whatever row security withholds is simply absent from the answer.
 */

import { panic } from "better-result";
import { inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewReferencePassages } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import {
  brandPersistedDocumentReviewReferencePassageId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type {
  Position,
  PositionTermKind,
  ReferencePassage,
} from "@/api/lib/workflow/playbook-positions";

/** Matches `referencePassageSchema`'s former inline bound; a quoted block
 *  longer than this is not one passage. */
export const REFERENCE_PASSAGE_TEXT_MAX_LENGTH = 10_000;

/** A passage together with its words, as the proposal pass and the grader
 *  hold it in memory. Never part of a persisted position. */
export type QuotedReferencePassage = {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  blockId: string;
  text: string;
};

/** A quoted passage pinned to its row: what a position stores plus the words
 *  the caller just wrote or read. */
export type PinnedReferencePassage = ReferencePassage & { text: string };

type GradedPosition = Extract<Position, { mode: "graded" }>;

/** A reference-derived position as the proposal pass produces it, before its
 *  passages have rows: the words are still attached. Pinned before it is
 *  answered to a client or persisted anywhere. */
export type ProposedReferencePosition = Omit<GradedPosition, "standard"> & {
  standard: {
    source: "reference";
    termKind: PositionTermKind;
    passages: QuotedReferencePassage[];
  };
};

const passageKey = (passage: { entityVersionId: string; blockId: string }) =>
  `${passage.entityVersionId}:${passage.blockId}`;

type PinReferencePassagesArgs = {
  organizationId: SafeId<"organization">;
  passages: readonly QuotedReferencePassage[];
};

/**
 * Write the quoted passages as rows and answer them with their ids, in the
 * order given. Content-addressed by (version, block), so a block already
 * pinned by an earlier proposal is reused rather than duplicated. Runs in the
 * caller's scoped transaction: the insert policy refuses a passage from a
 * matter the caller cannot open.
 */
export const pinReferencePassages = async (
  tx: Pick<Transaction, "insert">,
  { organizationId, passages }: PinReferencePassagesArgs,
): Promise<PinnedReferencePassage[]> => {
  if (passages.length === 0) {
    return [];
  }
  const unique = new Map<string, QuotedReferencePassage>();
  for (const passage of passages) {
    unique.set(passageKey(passage), passage);
  }
  const rows = await tx
    .insert(documentReviewReferencePassages)
    .values(
      [...unique.values()].map((passage) => ({
        id: createSafeId<"documentReviewReferencePassage">(),
        organizationId,
        workspaceId: passage.workspaceId,
        entityId: passage.entityId,
        fileFieldId: passage.fileFieldId,
        entityVersionId: passage.entityVersionId,
        blockId: passage.blockId,
        text: passage.text,
      })),
    )
    // `DO UPDATE` rather than `DO NOTHING` so RETURNING yields the existing
    // row's id; the text is the same block of the same version either way.
    .onConflictDoUpdate({
      target: [
        documentReviewReferencePassages.entityVersionId,
        documentReviewReferencePassages.blockId,
      ],
      set: { text: sql`excluded.text` },
    })
    .returning({
      id: documentReviewReferencePassages.id,
      entityVersionId: documentReviewReferencePassages.entityVersionId,
      blockId: documentReviewReferencePassages.blockId,
    });
  const idByKey = new Map(rows.map((row) => [passageKey(row), row.id]));
  return passages.map((passage) => {
    const id = idByKey.get(passageKey(passage));
    if (id === undefined) {
      return panic("Reference passage insert returned no row for a passage");
    }
    return { ...passage, id };
  });
};

type PinProposedPositionsArgs = {
  organizationId: SafeId<"organization">;
  positions: readonly ProposedReferencePosition[];
};

/**
 * Pin every passage the proposed positions quote in one write and answer the
 * positions as they will be persisted: ids and provenance, no words.
 */
export const pinProposedPositions = async (
  tx: Pick<Transaction, "insert">,
  { organizationId, positions }: PinProposedPositionsArgs,
): Promise<Position[]> => {
  const pinned = await pinReferencePassages(tx, {
    organizationId,
    passages: positions.flatMap((position) => position.standard.passages),
  });
  let cursor = 0;
  return positions.map((position) => {
    const count = position.standard.passages.length;
    const passages = pinned.slice(cursor, cursor + count).map((passage) => ({
      id: passage.id,
      workspaceId: passage.workspaceId,
      entityId: passage.entityId,
      fileFieldId: passage.fileFieldId,
      entityVersionId: passage.entityVersionId,
      blockId: passage.blockId,
    }));
    cursor += count;
    return {
      ...position,
      standard: {
        source: "reference",
        termKind: position.standard.termKind,
        passages,
      },
    };
  });
};

/**
 * The matters a run's reference text came from, deduplicated: the pinned
 * references, and the matters its positions quote. The two differ when the
 * run reused a playbook saved out of an earlier run against other references.
 * The run's own matter is authorized by the handler and is not necessarily
 * among them.
 */
export const basisReferenceWorkspaceIds = (
  basis: DocumentReviewRunBasis,
): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>(
    basis.references.map((reference) => reference.workspaceId),
  );
  for (const position of basis.playbook.definitionSnapshot.positions.items) {
    if (
      position.mode !== "graded" ||
      position.standard.source !== "reference"
    ) {
      continue;
    }
    for (const passage of position.standard.passages) {
      ids.add(brandPersistedWorkspaceId(passage.workspaceId));
    }
  }
  return [...ids];
};

/** Every passage id a position list pins, deduplicated, in list order. */
export const referencePassageIds = (
  positions: readonly Position[],
): SafeId<"documentReviewReferencePassage">[] => {
  const ids = new Set<SafeId<"documentReviewReferencePassage">>();
  for (const position of positions) {
    if (
      position.mode !== "graded" ||
      position.standard.source !== "reference"
    ) {
      continue;
    }
    for (const passage of position.standard.passages) {
      ids.add(brandPersistedDocumentReviewReferencePassageId(passage.id));
    }
  }
  return [...ids];
};

/**
 * The words behind the given passage ids, keyed by id. Through a scoped
 * transaction this answers only the passages whose matter the caller can
 * open; through the service connection it answers every row that exists.
 * A passage whose row is gone (its document was deleted) is absent.
 */
export const readReferencePassageTexts = async (
  db: Pick<Transaction, "select">,
  ids: readonly SafeId<"documentReviewReferencePassage">[],
): Promise<ReadonlyMap<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: documentReviewReferencePassages.id,
      text: documentReviewReferencePassages.text,
    })
    .from(documentReviewReferencePassages)
    .where(inArray(documentReviewReferencePassages.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.text]));
};

/**
 * The passage ids among `ids` whose rows the caller's transaction can read.
 * What a pin must check before a position list is persisted: the grader later
 * reads these rows with service access on the pinner's behalf.
 */
export const readableReferencePassageIds = async (
  db: Pick<Transaction, "select">,
  ids: readonly SafeId<"documentReviewReferencePassage">[],
): Promise<ReadonlySet<string>> => {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: documentReviewReferencePassages.id })
    .from(documentReviewReferencePassages)
    .where(inArray(documentReviewReferencePassages.id, [...ids]));
  return new Set(rows.map((row) => row.id));
};
