/**
 * How a review run reads for one reader when its positions were derived from
 * reference documents in other matters.
 *
 * A reference position's finding is written from the reference's own terms:
 * the standard side of the delta, the comparison prose, the recommendation and
 * the proposed fix all restate them. The passages themselves are served per
 * reader by `reference-passages.ts`; this module applies the same rule to the
 * rest of the finding and to the run's pinned basis. A reader who can open
 * every matter a position's passages came from sees the finding and the
 * position as written; otherwise the finding keeps its verdict, target
 * citations and passage ids, the position keeps its identity, issue and
 * passage ids, and both drop the other reference-derived fields; the run's
 * reference list keeps ids but not names or content digests.
 *
 * Every endpoint that returns findings or a run basis goes through here.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
import { Result } from "better-result";
import { inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { LANGUAGE_DELTA } from "@/api/lib/document-review/review-delta";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import type {
  DocumentReviewRunBasis,
  PinnedPlaybook,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";

/** The matters each reference position's passages came from, by `sourceId`. */
export const referenceWorkspacesByPosition = (
  basis: DocumentReviewRunBasis,
): ReadonlyMap<string, readonly string[]> => {
  const byPosition = new Map<string, string[]>();
  for (const position of basis.playbook.definitionSnapshot.positions.items) {
    if (
      position.mode !== "graded" ||
      position.standard.source !== "reference"
    ) {
      continue;
    }
    byPosition.set(position.sourceId, [
      ...new Set(position.standard.passages.map((p) => p.workspaceId)),
    ]);
  }
  return byPosition;
};

const referencedWorkspaceIds = (
  basis: DocumentReviewRunBasis,
): SafeId<"workspace">[] => {
  const ids = new Set<string>(basis.references.map((r) => r.workspaceId));
  for (const workspaceIds of referenceWorkspacesByPosition(basis).values()) {
    for (const id of workspaceIds) {
      ids.add(id);
    }
  }
  return [...ids].map(brandPersistedWorkspaceId);
};

/**
 * The subset of the run's reference matters this reader can open. Read through
 * the reader's own scoped connection, so row security decides.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
export const readableReferenceWorkspaces = async function* ({
  safeDb,
  basis,
}: {
  safeDb: SafeDb;
  basis: DocumentReviewRunBasis;
}) {
  const ids = referencedWorkspaceIds(basis);
  if (ids.length === 0) {
    return new Set<string>();
  }
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(inArray(workspaces.id, ids))
        .limit(ids.length),
    ),
  );
  return new Set<string>(rows.map(({ id }) => id));
};

export type ReaderReference = Omit<
  PinnedReference,
  "workspaceName" | "name" | "contentSha256"
> & {
  workspaceName: string | null;
  name: string | null;
  contentSha256: string | null;
};

/** The run's reference list for this reader: names and content digests only
 *  where readable. */
export const referencesForReader = (
  references: readonly PinnedReference[],
  readable: ReadonlySet<string>,
): ReaderReference[] =>
  references.map((reference) =>
    readable.has(reference.workspaceId)
      ? reference
      : { ...reference, workspaceName: null, name: null, contentSha256: null },
  );

type BasisPosition = PlaybookPositions["items"][number];

type ReaderPosition = BasisPosition & {
  /** Set when the reference-derived fields were left out for this reader. */
  referenceDetail?: "withheld";
};

/**
 * One pinned position for this reader. A reference position's prose (purpose,
 * guidance, negotiation notes, a derived question or check) was written from
 * the reference's terms, so a reader who cannot open every matter its passages
 * came from gets the position's identity, issue, severity and passage ids only,
 * as `findingForReader` does for its finding.
 */
const positionForReader = (
  position: BasisPosition,
  readable: ReadonlySet<string>,
): ReaderPosition => {
  if (
    position.mode !== "graded" ||
    position.standard.source !== "reference" ||
    position.standard.passages.every((passage) =>
      readable.has(passage.workspaceId),
    )
  ) {
    return position;
  }
  return {
    mode: position.mode,
    sourceId: position.sourceId,
    issue: position.issue,
    severity: position.severity,
    standard: position.standard,
    ask: { mode: "auto" },
    enabled: position.enabled,
    referenceDetail: "withheld",
  };
};

/** The run basis as one reader sees it. */
export type ReaderBasis = {
  playbook: Omit<PinnedPlaybook, "definitionSnapshot"> & {
    definitionSnapshot: {
      name: string;
      positions: Omit<PlaybookPositions, "items"> & {
        items: ReaderPosition[];
      };
    };
  };
  references: ReaderReference[];
  perspective: DocumentReviewRunBasis["perspective"];
};

/**
 * The pinned basis for this reader: every position through
 * {@link positionForReader} and the reference list through
 * {@link referencesForReader}. Every response that carries a run basis
 * returns this, never the stored basis.
 */
export const basisForReader = (
  basis: DocumentReviewRunBasis,
  readable: ReadonlySet<string>,
): ReaderBasis => {
  const { playbook } = basis;
  const { definitionSnapshot } = playbook;
  return {
    playbook: {
      definitionId: playbook.definitionId,
      versionId: playbook.versionId,
      provenance: playbook.provenance,
      definitionSnapshot: {
        name: definitionSnapshot.name,
        positions: {
          version: definitionSnapshot.positions.version,
          items: definitionSnapshot.positions.items.map((position) =>
            positionForReader(position, readable),
          ),
        },
      },
    },
    references: referencesForReader(basis.references, readable),
    perspective: basis.perspective,
  };
};

export type ReaderFinding = ReviewFinding & {
  /** Set when the reference-derived fields were left out for this reader. */
  referenceDetail?: "withheld";
};

/**
 * One finding for this reader. Tier-graded findings and findings whose
 * reference matters are all readable are returned unchanged.
 */
export const findingForReader = (
  finding: ReviewFinding,
  {
    positionWorkspaces,
    readable,
  }: {
    positionWorkspaces: ReadonlyMap<string, readonly string[]>;
    readable: ReadonlySet<string>;
  },
): ReaderFinding => {
  const sources = positionWorkspaces.get(finding.positionId);
  if (sources === undefined || sources.every((id) => readable.has(id))) {
    return finding;
  }
  return {
    positionId: finding.positionId,
    issue: finding.issue,
    severity: finding.severity,
    standardSource: finding.standardSource,
    verdict: finding.verdict,
    delta: LANGUAGE_DELTA,
    extracted: finding.extracted,
    rationale: null,
    citations: finding.citations,
    // Passage ids only (older rows may carry more); their text resolves
    // through the passages endpoint, which answers per reader.
    referenceCitations: arrayOrEmpty(finding.referenceCitations).map(
      ({ fileFieldId, passages }) => ({
        fileFieldId,
        passages: passages.map(({ id, blockId }) => ({ id, blockId })),
      }),
    ),
    recommendation: null,
    fix: null,
    referenceDetail: "withheld",
  };
};
