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
import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";

import type { Block } from "@/api/handlers/case-law/document-ast";
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
import {
  scanRun,
  US_CITATION_WORK_LIMIT,
} from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import type {
  DecisionSection,
  DecisionSectionType,
} from "@/api/lib/legal-search/document-types";
import type { CitationOpinionScope } from "@/api/lib/legal-search/ingestion-types";

import {
  composeFrontMatter,
  type CourtListenerFrontMatter,
} from "./front-matter";
import {
  hasUnprovenBoundaries,
  unitClass,
  unrecognizedOpinionType,
} from "./opinion-class";
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
  readonly unknownOpinionTypes: Readonly<Record<string, number>>;
  /** Principal text resumed after a nested opinion; scope splitting is conservative. */
  readonly resumedPrincipalRuns: number;
  readonly duplicateCaptionParagraphs: number;
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
      readonly principal: {
        readonly body: string;
        /** Whitespace-collapsed principal length in Unicode code points. */
        readonly length: number;
        readonly bodyParagraphCount: number;
        /** Supported full and short citations, excluding note and apparatus text. */
        readonly inBodyCitationCount:
          | { readonly status: "counted"; readonly count: number }
          | {
              readonly status: "unavailable";
              readonly reason: "scan-work-limit";
            };
      };
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
    const noteId = "note" in block ? block.note?.noteId : undefined;
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

type ScopedRow = {
  readonly scopes: CitationOpinionScope[];
  readonly coverage: "opinion" | "block-only";
  readonly classConflicts: number;
  readonly principal: TextUnit[];
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
  const principal: TextUnit[] = [];
  let proven = 0;
  let unproven = 0;
  let classConflicts = 0;
  let outsideNotes = 0;
  for (const unit of units) {
    if (unit.kind === "outside") {
      // Some HTML conversions append marked notes after the opinion container.
      // Their own boundaries are explicit even when ownership by a sub-opinion is not.
      for (const group of blockGroups(unit.blocks)) {
        const first = group.at(0);
        if (
          first === undefined ||
          !("note" in first) ||
          first.note === undefined
        ) {
          continue;
        }
        outsideNotes += 1;
        scopes.push({
          opinionId: `${base}/note-${outsideNotes}`,
          blockIds: group.map(({ id }) => id),
          boundaries: unit.boundaries === "markup" ? "proven" : "unproven",
        });
      }
      continue;
    }
    const unitType = unitClass(type, unit.domType, unit.position);
    classConflicts += unitType.conflict ? 1 : 0;
    if (unitType.principal) {
      principal.push(unit);
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
  duplicateCaptionParagraphs = 0,
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
  unknownOpinionTypes: (() => {
    const counts = new Map<string, number>();
    if (selection.status === "parsed") {
      for (const unit of selection.text.units) {
        const unknown = unrecognizedOpinionType(unit.domType);
        if (unknown !== null) {
          counts.set(unknown, (counts.get(unknown) ?? 0) + 1);
        }
      }
    }
    return Object.fromEntries(counts);
  })(),
  resumedPrincipalRuns: (() => {
    let interrupted = false;
    let resumed = 0;
    if (selection.status === "parsed") {
      for (const unit of selection.text.units) {
        if (unit.position === "nested") {
          interrupted = true;
        } else if (
          unit.kind === "opinion" &&
          unit.position === "row" &&
          interrupted
        ) {
          resumed += 1;
          interrupted = false;
        }
      }
    }
    return resumed;
  })(),
  duplicateCaptionParagraphs,
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
    if ("note" in block && block.note !== undefined && bodyType === "header") {
      type = "unknown";
    } else if (block.type === "paragraph") {
      if (
        isApparatusRole(block.role) ||
        block.role === "panel" ||
        block.role === "parties" ||
        block.role === "front-matter" ||
        block.role === "case-number"
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
  const principal: TextUnit[] = [];
  const reports = selected.map(({ opinion, selection }) => {
    if (selection.status !== "parsed") {
      return report(opinion, selection, null);
    }
    // Only headmatter equality removes a paragraph; repeated body language is
    // never deduplicated. Scope construction follows removal, so no stale IDs remain.
    const captionText = new Set(
      front.blocks
        .filter((block) => block.id.startsWith("cl-headmatter-"))
        .map((block) => block.plainText),
    );
    let duplicateCaptionParagraphs = 0;
    const units = selection.text.units.flatMap((unit) => {
      const kept = unit.blocks.filter((block) => {
        if (
          block.type !== "paragraph" ||
          block.note !== undefined ||
          !captionText.has(block.plainText)
        ) {
          return true;
        }
        duplicateCaptionParagraphs += 1;
        return false;
      });
      return kept.length === 0 ? [] : [{ ...unit, blocks: kept }];
    });
    const scoped = scopeRow(opinion, units);
    // A damaged note span leaves principal-body membership as unproven too.
    if (selection.text.counts.noteSpanDefects > 0) {
      scoped.principal.length = 0;
    }
    for (const unit of units) {
      blocks.push(...unit.blocks);
      let section: DecisionSectionType = "header";
      if (unit.kind !== "outside") {
        const { body } = unitClass(opinion.type, unit.domType, unit.position);
        section =
          body === "argumentation" || body === "dissent" ? body : "unknown";
      }
      appendSections(sections, unit.blocks, section);
    }
    citationScopes.push(...scoped.scopes);
    principal.push(...scoped.principal);
    return report(opinion, selection, scoped, duplicateCaptionParagraphs);
  });

  const indexed = indexCitationScopes(blocks, citationScopes);
  if (Result.isError(indexed)) {
    return {
      status: "scope-defect",
      defect: indexed.error.defect,
      opinions: reports,
    };
  }

  const bodyBlocks = principal
    .flatMap((unit) => unit.blocks)
    .filter(isPrincipalBody);
  const body = bodyBlocks.map(({ plainText }) => plainText).join("\n");
  const citationBudget = { limit: US_CITATION_WORK_LIMIT, spent: 0 };
  const citationCount = Result.gen(function* () {
    let count = 0;
    for (const block of bodyBlocks) {
      if (block.type !== "paragraph") {
        continue;
      }
      const scanned = yield* scanRun(block.inlines, {
        budget: citationBudget,
        identityKey: ({ value }) => value,
      });
      for (const event of scanned.events) {
        if (event.kind === "token" && event.token.kind !== "barrier") {
          count += 1;
        }
      }
    }
    return Result.ok(count);
  });
  return {
    status: "parsed",
    blocks,
    sections,
    textFields: front.textFields,
    citationScopes,
    principal: {
      body,
      length: Array.from(
        stripDangerousChars(body).normalize("NFC").replace(/\s+/gu, " ").trim(),
      ).length,
      bodyParagraphCount: bodyBlocks.length,
      inBodyCitationCount: Result.isError(citationCount)
        ? { status: "unavailable", reason: "scan-work-limit" }
        : { status: "counted", count: citationCount.value },
    },
    opinions: reports,
  };
};
