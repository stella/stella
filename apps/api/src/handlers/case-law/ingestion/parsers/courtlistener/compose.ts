/**
 * One cluster's opinions composed into one document: the rows in their
 * documented order, each row's blocks under its own ID prefix, and a citation
 * scope for every opinion so no short form resolves across an opinion
 * boundary.
 *
 * Every row must yield text. One row that cannot holds the whole cluster;
 * no opinion is published without the others.
 */

import { Result } from "better-result";

import { isApparatusRole } from "@stll/legal-ast/document-ast";

import type { Block } from "@/api/handlers/case-law/document-ast";
import type { PrincipalTextEvidence } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/order-classification";
import {
  COURTLISTENER_REJECTION_REASON,
  type CourtListenerRejectionReason,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/rejection";
import type { OpinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/snapshot-columns";
import {
  compareOpinionOrder,
  type OpinionType,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";
import { indexCitationScopes } from "@/api/handlers/case-law/ingestion/citation-scopes";
import type {
  DecisionSection,
  DecisionSectionType,
} from "@/api/lib/legal-search/document-types";
import type { CitationOpinionScope } from "@/api/lib/legal-search/ingestion-types";

import {
  composeFrontMatter,
  type CourtListenerFrontMatter,
} from "./front-matter";
import { hasUnprovenBoundaries, unitClass } from "./opinion-class";
import { createTextBudget, type TextCounts, type TextUnit } from "./outcome";
import { type OpinionTextSelection, selectOpinionText } from "./select";

export type CourtListenerTextOpinion = {
  readonly row: OpinionRow;
  readonly type: OpinionType;
};

/** What became of one opinion row, bounded and free of source text. */
type OpinionTextReport = {
  readonly opinionId: string;
  readonly type: OpinionType;
  readonly selection: OpinionTextSelection["status"];
  readonly format: string | null;
  readonly structure: string | null;
  readonly attempts: OpinionTextSelection["attempts"];
  readonly counts: TextCounts | null;
  /** `block-only` where no opinion boundary inside the row is proven. */
  readonly coverage: "opinion" | "block-only" | null;
  readonly scopes: number;
  /** Units whose row type and element type state different classes. */
  readonly classConflicts: number;
};

type HeldReason = Extract<
  CourtListenerRejectionReason,
  "no-usable-text" | "requires-assets" | "over-limit"
>;

export type CourtListenerTextOutcome =
  | {
      readonly status: "parsed";
      readonly blocks: readonly Block[];
      readonly sections: DecisionSection[];
      readonly textFields: {
        headnotes: string;
        syllabus: string;
        summary: string;
      };
      readonly citationScopes: readonly CitationOpinionScope[];
      readonly principal: Extract<PrincipalTextEvidence, { status: "parsed" }>;
      readonly opinions: readonly OpinionTextReport[];
    }
  | {
      readonly status: "held";
      readonly reason: HeldReason;
      readonly opinions: readonly OpinionTextReport[];
    }
  /** The composed scopes failed their own validation: a parser defect. */
  | {
      readonly status: "scope-defect";
      readonly defect: string;
      readonly opinions: readonly OpinionTextReport[];
    };

/** The roles that carry the court's own running text. */
const isPrincipalBody = (block: Block): boolean =>
  block.type === "paragraph" &&
  block.note === undefined &&
  !isApparatusRole(block.role) &&
  block.role !== "panel" &&
  block.role !== "parties" &&
  block.role !== "front-matter" &&
  block.role !== "case-number";

/**
 * Consecutive blocks of one footnote stay one scope: a note is one unit of
 * text even where the opinion around it is not proven.
 */
const blockGroups = (blocks: readonly Block[]): Block[][] => {
  const groups: Block[][] = [];
  let previousNote: string | undefined;
  for (const block of blocks) {
    const noteId = block.type === "paragraph" ? block.note?.noteId : undefined;
    const last = groups.at(-1);
    if (last !== undefined && noteId !== undefined && noteId === previousNote) {
      last.push(block);
    } else {
      groups.push([block]);
    }
    previousNote = noteId;
  }
  return groups;
};

/** A unit that may be read as the principal text, with what proves it. */
type PrincipalUnit = {
  readonly unit: TextUnit;
  /** The class the row and markup prove; `unknown` proves no opinion. */
  readonly body: ReturnType<typeof unitClass>["body"];
  readonly structural: boolean;
};

type ScopedRow = {
  readonly scopes: CitationOpinionScope[];
  readonly coverage: "opinion" | "block-only";
  readonly classConflicts: number;
  readonly principal: PrincipalUnit[];
};

/**
 * Scopes for one row. A unit whose markup proves its boundaries is one
 * scope: the row's first is `cl-opinion:<id>`, each further one
 * `cl-opinion:<id>/<n>`. A unit whose boundaries are not proven (layout
 * text, where notes are not marked, or a combined row without a stated
 * class) scopes each block, or each whole note, alone as
 * `cl-opinion:<id>/block-<n>`. Text outside every opinion element is in no
 * scope.
 */
const scopeRow = (
  { row, type }: CourtListenerTextOpinion,
  units: readonly TextUnit[],
): ScopedRow => {
  const base = `cl-opinion:${row.id}`;
  const scopes: CitationOpinionScope[] = [];
  const principal: PrincipalUnit[] = [];
  let proven = 0;
  let unproven = 0;
  let classConflicts = 0;
  for (const unit of units) {
    if (unit.kind === "outside") {
      continue;
    }
    const unitType = unitClass(type, unit.domType, unit.position);
    classConflicts += unitType.conflict ? 1 : 0;
    if (unitType.principal) {
      principal.push({
        unit,
        body: unitType.body,
        structural: unitType.structural,
      });
    }
    if (
      unit.boundaries === "layout" ||
      hasUnprovenBoundaries(type, unit.domType, unit.position)
    ) {
      for (const group of blockGroups(unit.blocks)) {
        unproven += 1;
        scopes.push({
          opinionId: `${base}/block-${unproven}`,
          blockIds: group.map(({ id }) => id),
          boundaries: "unproven",
        });
      }
      continue;
    }
    proven += 1;
    scopes.push({
      opinionId: proven === 1 ? base : `${base}/${proven}`,
      blockIds: unit.blocks.map(({ id }) => id),
      boundaries: "proven",
    });
  }
  return {
    scopes,
    coverage: unproven > 0 ? "block-only" : "opinion",
    classConflicts,
    principal,
  };
};

const report = (
  { row, type }: CourtListenerTextOpinion,
  selection: OpinionTextSelection,
  scoped: ScopedRow | null,
): OpinionTextReport => ({
  opinionId: row.id,
  type,
  selection: selection.status,
  format: "format" in selection ? selection.format : null,
  structure: selection.status === "parsed" ? selection.structure : null,
  attempts: selection.attempts,
  counts: selection.status === "parsed" ? selection.text.counts : null,
  coverage: scoped?.coverage ?? null,
  scopes: scoped?.scopes.length ?? 0,
  classConflicts: scoped?.classConflicts ?? 0,
});

/** Why a cluster is held, the most fundamental reason first. */
const heldReason = (
  selections: readonly OpinionTextSelection[],
): HeldReason | null => {
  const statuses = new Set(selections.map(({ status }) => status));
  if (statuses.has("over-limit")) {
    return COURTLISTENER_REJECTION_REASON.OVER_LIMIT;
  }
  if (statuses.has("requires-assets")) {
    return COURTLISTENER_REJECTION_REASON.REQUIRES_ASSETS;
  }
  if (statuses.has("no-usable-text")) {
    return COURTLISTENER_REJECTION_REASON.NO_USABLE_TEXT;
  }
  return null;
};

const appendSections = (
  sections: DecisionSection[],
  blocks: readonly Block[],
  bodyType: DecisionSectionType,
): void => {
  let current: DecisionSection | undefined;
  for (const block of blocks) {
    let type = bodyType;
    if (block.type === "paragraph") {
      if (
        isApparatusRole(block.role) ||
        block.role === "panel" ||
        block.role === "parties" ||
        block.role === "front-matter" ||
        block.role === "case-number" ||
        block.role === "counsel"
      ) {
        type = "header";
      } else if (block.role === "history") {
        type = "history";
      }
    }
    if (current === undefined || current.type !== type) {
      current = {
        index: sections.length,
        type,
        title: null,
        text: block.plainText,
      };
      sections.push(current);
    } else {
      current.text += `\n\n${block.plainText}`;
    }
  }
};

/**
 * Parses and composes a cluster's opinion rows. Pure: every candidate is a
 * string already in the rows.
 */
export const composeCourtListenerText = (
  opinions: readonly CourtListenerTextOpinion[],
  frontMatter: CourtListenerFrontMatter = {},
): CourtListenerTextOutcome => {
  const budget = createTextBudget();
  const selected = opinions.toSorted(compareOpinionOrder).map((opinion) => ({
    opinion,
    selection: selectOpinionText({ ...opinion, budget }),
  }));

  const held = heldReason(selected.map(({ selection }) => selection));
  if (held !== null) {
    const reports = selected.map(({ opinion, selection }) =>
      report(opinion, selection, null),
    );
    return { status: "held", reason: held, opinions: reports };
  }

  const blocks: Block[] = [];
  const sections: DecisionSection[] = [];
  const front = composeFrontMatter({
    budget,
    source: frontMatter,
    existing: selected.flatMap(({ selection }) =>
      selection.status === "parsed"
        ? selection.text.units.flatMap((unit) => [...unit.blocks])
        : [],
    ),
  });
  if (front.status === "held") {
    return {
      ...front,
      opinions: selected.map(({ opinion, selection }) =>
        report(opinion, selection, null),
      ),
    };
  }
  blocks.push(...front.blocks);
  appendSections(sections, front.blocks, "header");
  const citationScopes: CitationOpinionScope[] = [];
  const principal: PrincipalUnit[] = [];
  const reports = selected.map(({ opinion, selection }) => {
    if (selection.status !== "parsed") {
      return report(opinion, selection, null);
    }
    const { units } = selection.text;
    const scoped = scopeRow(opinion, units);
    for (const unit of units) {
      blocks.push(...unit.blocks);
      const role =
        unit.kind === "outside"
          ? "header"
          : unitClass(opinion.type, unit.domType, unit.position).body;
      appendSections(
        sections,
        unit.blocks,
        role === "argumentation" || role === "dissent"
          ? role
          : unit.kind === "outside"
            ? "header"
            : "unknown",
      );
    }
    citationScopes.push(...scoped.scopes);
    principal.push(...scoped.principal);
    return report(opinion, selection, scoped);
  });

  const indexed = indexCitationScopes(blocks, citationScopes);
  if (Result.isError(indexed)) {
    return {
      status: "scope-defect",
      defect: indexed.error.defect,
      opinions: reports,
    };
  }

  const [first] = principal;
  const titles = new Set(
    principal.flatMap(({ unit }) =>
      unit.orderTitleBlockId === null ? [] : [unit.orderTitleBlockId],
    ),
  );
  return {
    status: "parsed",
    blocks,
    sections,
    textFields: front.textFields,
    citationScopes,
    principal: {
      status: "parsed",
      // The principal text opens with a root `ORDER` title of its own.
      orderHeading:
        first !== undefined && first.unit.orderTitleBlockId !== null,
      body: principal
        .flatMap(({ unit }) => unit.blocks)
        .filter((block) => isPrincipalBody(block) && !titles.has(block.id))
        .map(({ plainText }) => plainText)
        .join("\n"),
      structuralOpinion: principal.some(
        ({ body, structural }) => structural && body === "argumentation",
      ),
      // One scope of source text is not one proven opinion: the unit must
      // also be of a class the row or markup states.
      singleOpinionBody:
        principal.length === 1 &&
        first !== undefined &&
        first.body !== "unknown",
    },
    opinions: reports,
  };
};
