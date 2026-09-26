/**
 * Reporter references in a decision, in the order a reader meets them, each
 * with the decision it names or the reason its text does not settle one.
 *
 * The walk visits blocks, then table cells, in document order, scans each
 * run, and hands every token to its scope's antecedent state. Once every
 * bundle is in, each occurrence reads its target from its entity, so a
 * later parallel reference that proves two printings conflict reaches every
 * occurrence of both. Everything else abstains with its reason, because a
 * wrong link reads as authority and a missing one reads as nothing.
 */

import { panic, Result, TaggedError } from "better-result";

import type {
  DecisionIdentifiers,
  ReporterCitationIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type {
  CitationUnresolvedReason,
  InlineCitationPin,
  InlineCitationTarget,
} from "@stll/legal-ast/inline";

import type { CitationScopeIndex } from "@/api/handlers/case-law/ingestion/citation-scopes";
import { annotateUsCitations } from "@/api/handlers/case-law/ingestion/us-citation-annotations";
import {
  closeClause,
  createScopeRegistry,
  recordBarrier,
  recordFull,
  resolveShort,
} from "@/api/handlers/case-law/ingestion/us-citation-antecedents";
import type {
  AntecedentContext,
  PinReporterRule,
  Reading,
  ScopeRegistry,
} from "@/api/handlers/case-law/ingestion/us-citation-antecedents";
import { createBundleGraph } from "@/api/handlers/case-law/ingestion/us-citation-bundles";
import type {
  BundleGraph,
  EntityTarget,
  UsCitationBundleOverflowError,
} from "@/api/handlers/case-law/ingestion/us-citation-bundles";
import {
  scanRun,
  US_CITATION_WORK_LIMIT,
  workBudgetExhausted,
} from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import type {
  BarrierKind,
  CitationWorkBudget,
  ReporterIdentityKey,
  ScannedPin,
  ScannedRun,
  Token,
  UsCitationWorkBudgetError,
} from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import type { DocumentAst, Inline } from "@/api/lib/case-law/document-ast";

/** Occurrences one decision may carry before extraction rejects it. */
export const US_CITATION_OCCURRENCE_LIMIT = 50_000;

export class UsCitationOccurrenceOverflowError extends TaggedError(
  "UsCitationOccurrenceOverflowError",
)<{
  message: string;
  limit: number;
}> {}

type UsCitationForm = Exclude<Token["kind"], "barrier">;

export type UsCitationOccurrence = {
  /** The search section carrying this block; null when none carries it. */
  sectionIndex: number | null;
  blockId: string;
  cell?: { row: number; column: number } | undefined;
  /** Half-open UTF-16 offsets on `plainTextOf` of the run's inlines. */
  start: number;
  end: number;
  /** Null outside every opinion the parser stated. */
  opinionId: string | null;
  noteId: string | null;
  form: UsCitationForm;
  target: InlineCitationTarget;
  pin?: InlineCitationPin | undefined;
};

/** One cited decision, as the citation graph records it. */
export type UsCitedDecision = {
  /** The latest full reference to it, as printed. */
  citationText: string;
  sectionIndex: number | null;
  /** Primary first, then its parallel identities. */
  identifiers: DecisionIdentifiers;
};

/** What the pass read but could not turn into a target, for recall review. */
export type UsCitationDiagnostics = {
  /** Work spent against `US_CITATION_WORK_LIMIT`. */
  work: number;
  /** Authority spans no supported grammar names, by kind. */
  barriers: Record<BarrierKind, number>;
  /** Pin lists too long for an annotation to hold; their pins are omitted. */
  overlongPins: number;
};

export type UsCitationExtraction = {
  occurrences: UsCitationOccurrence[];
  citedDecisions: UsCitedDecision[];
  documentAst: DocumentAst;
  diagnostics: UsCitationDiagnostics;
};

export type UsCitationRejection =
  | UsCitationBundleOverflowError
  | UsCitationOccurrenceOverflowError
  | UsCitationWorkBudgetError;

// ---------------------------------------------------------------------------
// The document walk

type TextRun = {
  blockId: string;
  cell?: { row: number; column: number } | undefined;
  inlines: readonly Inline[];
  registryKey: string;
  known: boolean;
  opinionId: string | null;
  noteId: string | null;
  /** The block's projected text, for locating its search section. */
  blockText: string;
};

/**
 * Every text run with its scope: the opinion the block belongs to, then its
 * note (a note without an ID is its own), or its table cell. Outside every
 * stated opinion a block is a scope by itself.
 */
const runsOf = (
  ast: DocumentAst,
  scopes: CitationScopeIndex | undefined,
): TextRun[] => {
  const runs: TextRun[] = [];
  for (const block of ast.blocks) {
    const opinionId = scopes?.get(block.id) ?? null;
    const known = opinionId !== null;
    const noteId =
      block.type === "paragraph" && block.note !== undefined
        ? (block.note.noteId ?? block.id)
        : null;
    const scopeKey = known ? `opinion:${opinionId}` : `block:${block.id}`;
    const noteKey = noteId === null ? "" : `\u0000note:${noteId}`;
    const shared = {
      blockId: block.id,
      known,
      opinionId,
      noteId,
      blockText: block.plainText,
    };
    switch (block.type) {
      case "heading":
      case "paragraph":
        runs.push({
          ...shared,
          inlines: block.inlines,
          registryKey: `${scopeKey}${noteKey}`,
        });
        break;
      case "table":
        for (const [row, cells] of block.rows.entries()) {
          for (const [column, cell] of cells.entries()) {
            runs.push({
              ...shared,
              cell: { row, column },
              inlines: cell.inlines,
              registryKey: `${scopeKey}\u0000cell:${block.id}:${String(row)}:${String(column)}`,
            });
          }
        }
        break;
      case "image":
        break;
      default: {
        block satisfies never;
        return panic("Unhandled block type");
      }
    }
  }
  return runs;
};

const SECTION_PARAGRAPH_SEPARATOR = "\n\n";

/**
 * Finds each block's search section by its text, never moving backwards.
 * Sections join their blocks' texts with a blank line, so each paragraph of
 * a section is indexed once and a lookup costs one map read.
 */
const sectionLocator = (
  sections: readonly { index: number; text: string }[],
): ((blockText: string) => number | null) => {
  const holders = new Map<string, number[]>();
  for (const [position, section] of sections.entries()) {
    for (const paragraph of section.text.split(SECTION_PARAGRAPH_SEPARATOR)) {
      const key = paragraph.trim();
      const held = holders.get(key);
      if (held === undefined) {
        holders.set(key, [position]);
      } else if (held.at(-1) !== position) {
        held.push(position);
      }
    }
  }
  let cursor = 0;
  return (blockText) => {
    const position = holders
      .get(blockText.trim())
      ?.find((candidate) => candidate >= cursor);
    if (position === undefined) {
      return null;
    }
    cursor = position;
    return sections[position]?.index ?? null;
  };
};

type PendingOccurrence = Omit<UsCitationOccurrence, "target" | "pin"> &
  Reading & {
    printed: string;
    pin: ScannedPin | null;
  };

const emptyDiagnostics = (): UsCitationDiagnostics => ({
  work: 0,
  barriers: {
    statute: 0,
    electronic: 0,
    "unsupported-authority": 0,
    treatise: 0,
  },
  overlongPins: 0,
});

export type ExtractUsCitationsOptions = {
  ast: DocumentAst;
  scopes: CitationScopeIndex | undefined;
  sections: readonly { index: number; text: string }[];
  identityKey: ReporterIdentityKey;
};

type Walk = {
  context: AntecedentContext;
  pending: PendingOccurrence[];
  diagnostics: UsCitationDiagnostics;
};

/** Reads one run's events into its scope, collecting its occurrences. */
/** A run, the scope it reads into, and the search section holding it. */
type RunInScope = {
  registry: ScopeRegistry;
  run: TextRun;
  place: Pick<UsCitationOccurrence, "sectionIndex">;
};

const readRun = (
  { context, diagnostics, pending }: Walk,
  { place, registry, run }: RunInScope,
  { events, text }: ScannedRun,
): Result<void, UsCitationRejection> => {
  let after = 0;
  for (const event of events) {
    if (event.kind === "sentence-end") {
      closeClause(registry);
      continue;
    }
    const { token } = event;
    if (token.kind === "barrier") {
      diagnostics.barriers[token.barrier] += 1;
      recordBarrier(registry);
      continue;
    }
    const site = { text, after };
    after = token.end;
    const reading =
      token.kind === "full"
        ? recordFull(context, registry, token, site)
        : Result.ok(resolveShort(context, registry, token, site));
    if (Result.isError(reading)) {
      return Result.err(reading.error);
    }
    if (token.pin?.type === "overlong") {
      diagnostics.overlongPins += 1;
    }
    pending.push({
      ...place,
      blockId: run.blockId,
      ...(run.cell === undefined ? {} : { cell: run.cell }),
      opinionId: run.opinionId,
      noteId: run.noteId,
      start: token.start,
      end: token.end,
      form: token.kind,
      printed: text.slice(token.start, token.end),
      pin: token.pin,
      ...reading.value,
    });
    if (pending.length > US_CITATION_OCCURRENCE_LIMIT) {
      return Result.err(
        new UsCitationOccurrenceOverflowError({
          message: `Decision exceeds ${String(US_CITATION_OCCURRENCE_LIMIT)} citation occurrences`,
          limit: US_CITATION_OCCURRENCE_LIMIT,
        }),
      );
    }
    if (context.budget.spent > context.budget.limit) {
      return Result.err(workBudgetExhausted(context.budget));
    }
  }
  closeClause(registry);
  return Result.ok(undefined);
};

/**
 * Every reporter reference in the decision with its target, one cited
 * decision per identified authority, and the document annotated with them.
 * Rejected, never truncated, past the occurrence, identity or work bounds.
 */
export const extractUsCitations = ({
  ast,
  identityKey,
  scopes,
  sections,
}: ExtractUsCitationsOptions): Result<
  UsCitationExtraction,
  UsCitationRejection
> => {
  const budget: CitationWorkBudget = {
    limit: US_CITATION_WORK_LIMIT,
    spent: 0,
  };
  const graph = createBundleGraph();
  const walk: Walk = {
    context: { graph, budget },
    pending: [],
    diagnostics: emptyDiagnostics(),
  };
  const registries = new Map<string, ScopeRegistry>();
  const locateSection = sectionLocator(sections);

  for (const run of runsOf(ast, scopes)) {
    const registry =
      registries.get(run.registryKey) ?? createScopeRegistry(run.known);
    registries.set(run.registryKey, registry);
    const scanned = scanRun(run.inlines, { identityKey, budget });
    if (Result.isError(scanned)) {
      return Result.err(scanned.error);
    }
    const carriesToken = scanned.value.events.some(
      ({ kind }) => kind === "token",
    );
    const read = readRun(
      walk,
      {
        registry,
        run,
        place: {
          sectionIndex: carriesToken ? locateSection(run.blockText) : null,
        },
      },
      scanned.value,
    );
    if (Result.isError(read)) {
      return Result.err(read.error);
    }
  }

  const { citedDecisions, occurrences } = settle(graph, walk.pending);
  const annotated = annotateUsCitations(ast, occurrences, budget);
  if (Result.isError(annotated)) {
    return Result.err(annotated.error);
  }
  walk.diagnostics.work = budget.spent;
  return Result.ok({
    occurrences,
    citedDecisions,
    documentAst: annotated.value,
    diagnostics: walk.diagnostics,
  });
};

// ---------------------------------------------------------------------------
// Settling targets

const pinReporterOf = (
  rule: PinReporterRule,
  target: EntityTarget,
): ReporterCitationIdentifier | undefined => {
  if (target.status !== "identified") {
    return undefined;
  }
  switch (rule.type) {
    case "base":
      return rule.base.identifier;
    case "single":
      return target.bases.length === 1 ? target.bases[0].identifier : undefined;
    case "edition":
      return target.bases.find(
        (base) =>
          base.volume === rule.volume && rule.editions.includes(base.edition),
      )?.identifier;
    case "none":
      return undefined;
    default: {
      rule satisfies never;
      return panic("Unhandled pin reporter rule");
    }
  }
};

const settle = (
  graph: BundleGraph,
  pending: readonly PendingOccurrence[],
): Pick<UsCitationExtraction, "occurrences" | "citedDecisions"> => {
  const latestFull = new Map<number, PendingOccurrence>();
  const occurrences: UsCitationOccurrence[] = [];
  for (const occurrence of pending) {
    const {
      pin,
      pinReporter,
      printed: _printed,
      resolution,
      ...place
    } = occurrence;
    const entity: EntityTarget | null =
      resolution.type === "bundle" ? graph.target(resolution.bundle) : null;
    let target: InlineCitationTarget;
    if (resolution.type === "unresolved") {
      target = { status: "unresolved", reason: resolution.reason };
    } else if (entity?.status === "identified") {
      const [primary, ...parallels] = entity.bases;
      target = {
        status: "identified",
        identifiers: [
          primary.identifier,
          ...parallels.map(({ identifier }) => identifier),
        ],
      };
      if (occurrence.form === "full") {
        latestFull.set(graph.root(resolution.bundle), occurrence);
      }
    } else {
      target = { status: "unresolved", reason: "conflicting-parallels" };
    }
    const reporter =
      entity === null ? undefined : pinReporterOf(pinReporter, entity);
    occurrences.push({
      ...place,
      target,
      ...(pin?.type === "pin"
        ? {
            pin: {
              raw: pin.raw,
              parts: pin.parts,
              ...(reporter === undefined ? {} : { reporter }),
            },
          }
        : {}),
    });
  }
  const citedDecisions: UsCitedDecision[] = [];
  for (const occurrence of latestFull.values()) {
    const entity =
      occurrence.resolution.type === "bundle"
        ? graph.target(occurrence.resolution.bundle)
        : null;
    if (entity?.status !== "identified") {
      continue;
    }
    const [primary, ...parallels] = entity.bases;
    citedDecisions.push({
      citationText: occurrence.printed,
      sectionIndex: occurrence.sectionIndex,
      identifiers: [
        primary.identifier,
        ...parallels.map(({ identifier }) => identifier),
      ],
    });
  }
  return { occurrences, citedDecisions };
};

/** How many annotations abstained, by reason: the recall these rules trade. */
export const countUnresolvedTargets = (
  occurrences: readonly UsCitationOccurrence[],
): Record<CitationUnresolvedReason, number> => {
  const counts: Record<CitationUnresolvedReason, number> = {
    "missing-antecedent": 0,
    "ambiguous-antecedent": 0,
    "ambiguous-reporter": 0,
    "authority-barrier": 0,
    "scope-unknown": 0,
    "conflicting-parallels": 0,
  };
  for (const { target } of occurrences) {
    if (target.status === "unresolved") {
      counts[target.reason] += 1;
    }
  }
  return counts;
};
