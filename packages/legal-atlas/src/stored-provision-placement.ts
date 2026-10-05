import { panic } from "better-result";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { LegislationExpressionEligibility } from "@stll/api-contract/legislation-expression";
import { versionCoversDate } from "@stll/api-contract/legislation-version-window";
import type { ProvisionPlacementFailureReason } from "@stll/api-contract/provision-placement";
import type { Block } from "@stll/legal-ast/document-ast";
import { fulltextProjectionPieces } from "@stll/legal-ast/projection-digest";
import { dropOverlappingSpans } from "@stll/legal-ast/text-spans";

import {
  provisionOccurrenceContexts,
  locateProvisionAnchors,
} from "./provision-placement";
import type { ProvisionAnchorSource } from "./provision-placement";

export type ProvisionPlacementVersion = LegislationExpressionEligibility & {
  id: string;
  eli: string | null;
  versionValidFrom: string | null;
  versionValidTo: string | null;
};

export type StoredProvisionPlacementRow = Pick<
  ProvisionAnchorSource,
  "id" | "reference" | "sentenceText" | "spanStart" | "exactSpan" | "occurrence"
> & {
  jurisdiction: CaseLawJurisdiction;
  workEli: string | null;
  versionValidFrom: string | null;
};

export type DecisionPlacementText =
  | { type: "blocks"; blocks: readonly Block[]; decisionDate: string | null }
  | { type: "fulltext"; text: string; decisionDate: string | null };

export type StoredProvisionPlacement<TVersion> =
  | {
      status: "placed";
      document: TVersion;
      pieceId: string;
      start: number;
      end: number;
    }
  | { status: "unplaced"; reason: ProvisionPlacementFailureReason };

type StoredProvisionPlacementOptions<TVersion> = {
  row: StoredProvisionPlacementRow;
  text: DecisionPlacementText;
  versions: readonly TVersion[];
};

/** One stored occurrence, its rendered text and available corpus versions. */
export const placeStoredProvision = <
  TVersion extends ProvisionPlacementVersion,
>({
  row,
  text,
  versions,
}: StoredProvisionPlacementOptions<TVersion>): StoredProvisionPlacement<TVersion> => {
  if (row.workEli === null) {
    return { status: "unplaced", reason: "work-unresolved" };
  }
  const workVersions = versions.filter(({ eli }) => eli === row.workEli);
  if (workVersions.length === 0) {
    return { status: "unplaced", reason: "statute-not-loaded" };
  }
  const asOf = row.versionValidFrom ?? text.decisionDate;
  if (asOf === null) {
    return { status: "unplaced", reason: "version-not-stated" };
  }
  const candidates = workVersions.filter((version) =>
    versionCoversDate(version, asOf),
  );
  const document = candidates.at(0);
  if (document === undefined) {
    return { status: "unplaced", reason: "no-version-in-force" };
  }
  if (candidates.length > 1) {
    return { status: "unplaced", reason: "ambiguous-version" };
  }
  const blocks =
    text.type === "blocks"
      ? text.blocks
      : fulltextProjectionPieces(text.text).map(
          ({ pieceId, text: paragraph }): Block => ({
            id: pieceId,
            anchorId: pieceId,
            type: "paragraph",
            plainText: paragraph,
            inlines: [{ type: "text", text: paragraph }],
          }),
        );
  const source = { ...row, target: document };
  const placement = locateProvisionAnchors({ blocks, provisions: [source] });
  const failure = placement.failures.at(0);
  if (failure !== undefined) {
    return { status: "unplaced", reason: failure.reason };
  }
  for (const [pieceId, spans] of Object.entries(placement.anchorsByPieceId)) {
    const span = spans.at(0);
    if (span !== undefined) {
      return {
        status: "placed",
        document,
        pieceId,
        start: span.start,
        end: span.end,
      };
    }
  }
  return panic("Stored provision placement has neither a span nor a failure");
};

/** Every row keeps an outcome, including occurrences whose targets are absent. */
export const placeStoredProvisions = <
  TVersion extends ProvisionPlacementVersion,
>({
  rows,
  text,
  versions,
}: {
  rows: readonly StoredProvisionPlacementRow[];
  text: DecisionPlacementText;
  versions: readonly TVersion[];
}) => {
  const contexts = provisionOccurrenceContexts(rows);
  const outcomes = rows.map((row) => ({
    id: row.id,
    placement: placeStoredProvision({
      row: { ...row, occurrence: contexts.get(row.id) },
      text,
      versions,
    }),
  }));
  const byPiece = new Map<
    string,
    { start: number; end: number; outcome: (typeof outcomes)[number] }[]
  >();
  for (const outcome of outcomes) {
    if (outcome.placement.status === "unplaced") {
      continue;
    }
    const { pieceId, start, end } = outcome.placement;
    const spans = byPiece.get(pieceId);
    if (spans === undefined) {
      byPiece.set(pieceId, [{ start, end, outcome }]);
    } else {
      spans.push({ start, end, outcome });
    }
  }
  for (const spans of byPiece.values()) {
    const retained = new Set(dropOverlappingSpans(spans));
    for (const span of spans) {
      if (!retained.has(span)) {
        span.outcome.placement = { status: "unplaced", reason: "span-overlap" };
      }
    }
  }
  return outcomes;
};
