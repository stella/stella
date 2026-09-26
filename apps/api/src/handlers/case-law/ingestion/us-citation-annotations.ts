/**
 * Writes reporter occurrences into a document's inlines as citation
 * wrappers, changing structure and never characters.
 *
 * A reference may cross a formatting boundary (`<em>Id., </em>at 865`), so a
 * wrapper sits at the deepest container holding the whole span, and the
 * containers it cuts through are split into copies that keep their formatting.
 * Page anchors and other zero-width nodes on a span's edge stay outside it.
 * Wrappers already in the text are coalesced rather than nested: one crossing
 * a span dissolves into it, and its link survives only when every dissolved
 * wrapper agreed on one. A wrapper crossing no span keeps its place but loses
 * any target or pin, which only this pass writes.
 *
 * Each run is two ordered sweeps over its tree with widths computed once, so
 * the work is linear in its nodes and spans; each visit is charged to the
 * extraction's work budget.
 *
 * `plainTextOf`, block IDs and anchors are unchanged, and annotating an
 * annotated document with the same occurrences is the identity.
 */

import { panic, Result } from "better-result";

import type { InlineCitation } from "@stll/legal-ast/inline";

import type { UsCitationOccurrence } from "@/api/handlers/case-law/ingestion/us-citation-occurrences";
import {
  chargeWork,
  workBudgetExhausted,
} from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import type {
  CitationWorkBudget,
  UsCitationWorkBudgetError,
} from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import {
  hasInlineChildren,
  plainTextOf,
} from "@/api/lib/case-law/document-ast";
import type {
  Block,
  DocumentAst,
  Inline,
} from "@/api/lib/case-law/document-ast";

type Span = {
  start: number;
  end: number;
  occurrence: UsCitationOccurrence;
  /** Links of the wrappers this span dissolved; `null` for an unlinked one. */
  hrefs: Set<string | null>;
};

type Sweep = {
  spans: readonly Span[];
  text: string;
  budget: CitationWorkBudget;
  widths: WeakMap<Inline, number>;
  /** The first span that may still overlap the node being visited. */
  next: number;
};

const widthOf = (sweep: Sweep, inline: Inline): number => {
  const cached = sweep.widths.get(inline);
  if (cached !== undefined) {
    return cached;
  }
  chargeWork(sweep.budget, 1);
  let width = 0;
  if (inline.type === "text") {
    width = inline.text.length;
  } else if (inline.type === "line-break") {
    width = 1;
  } else if (hasInlineChildren(inline)) {
    for (const child of inline.children) {
      width += widthOf(sweep, child);
    }
  }
  sweep.widths.set(inline, width);
  return width;
};

const withoutAnnotation = ({
  pin: _pin,
  target: _target,
  ...wrapper
}: InlineCitation): InlineCitation => wrapper;

/**
 * First sweep: dissolves every citation wrapper a span overlaps, recording
 * its link, and strips the annotation from every other wrapper. Spans are
 * visited in order, so the sweep never looks back at one it has passed.
 */
const dissolveWrappers = (
  sweep: Sweep,
  inlines: readonly Inline[],
  offset: number,
): Inline[] => {
  const out: Inline[] = [];
  let at = offset;
  for (const inline of inlines) {
    chargeWork(sweep.budget, 1);
    const end = at + widthOf(sweep, inline);
    if (!hasInlineChildren(inline)) {
      out.push(inline);
      at = end;
      continue;
    }
    while ((sweep.spans[sweep.next]?.end ?? Number.POSITIVE_INFINITY) <= at) {
      sweep.next += 1;
    }
    // Every span still ahead ends after `at`, so each one starting before
    // `end` overlaps this wrapper.
    let crossed = false;
    if (inline.type === "citation" && end > at) {
      for (
        let index = sweep.next;
        (sweep.spans[index]?.start ?? end) < end;
        index += 1
      ) {
        crossed = true;
        sweep.spans[index]?.hrefs.add(inline.href ?? null);
      }
    }
    const children = dissolveWrappers(sweep, inline.children, at);
    if (inline.type === "citation" && crossed) {
      out.push(...children);
    } else if (inline.type === "citation") {
      out.push({ ...withoutAnnotation(inline), children });
    } else {
      out.push({ ...inline, children });
    }
    at = end;
  }
  return out;
};

/**
 * Cuts a node at `point`, strictly inside it, copying each container on the
 * path. A zero-width node at the point goes to `zeroSide`.
 */
type Cut = { point: number; zeroSide: "left" | "right" };

const splitAt = (
  sweep: Sweep,
  inline: Inline,
  offset: number,
  cut: Cut,
): [Inline, Inline] => {
  const { point, zeroSide } = cut;
  if (inline.type === "text") {
    return [
      { ...inline, text: inline.text.slice(0, point - offset) },
      { ...inline, text: inline.text.slice(point - offset) },
    ];
  }
  if (!hasInlineChildren(inline)) {
    return panic("A node without width cannot hold a span edge");
  }
  const left: Inline[] = [];
  const right: Inline[] = [];
  let at = offset;
  for (const child of inline.children) {
    chargeWork(sweep.budget, 1);
    const end = at + widthOf(sweep, child);
    if (end === at) {
      (at < point || (at === point && zeroSide === "left") ? left : right).push(
        child,
      );
    } else if (end <= point) {
      left.push(child);
    } else if (at >= point) {
      right.push(child);
    } else {
      const [head, tail] = splitAt(sweep, child, at, cut);
      left.push(head);
      right.push(tail);
    }
    at = end;
  }
  return [
    { ...inline, children: left },
    { ...inline, children: right },
  ];
};

const wrapperOf = (
  { text }: Sweep,
  span: Span,
  children: Inline[],
): InlineCitation => {
  const [href, ...others] = span.hrefs;
  const { occurrence } = span;
  return {
    type: "citation",
    cite: text.slice(span.start, span.end),
    ...(href !== undefined && href !== null && others.length === 0
      ? { href }
      : {}),
    children,
    target: occurrence.target,
    ...(occurrence.pin === undefined ? {} : { pin: occurrence.pin }),
  };
};

/**
 * Second sweep over one level: spans `[from, to)` lie inside this level. A
 * span inside one container is wrapped within it; one crossing nodes of
 * this level is wrapped here, cutting the nodes on its edges.
 */
const wrapLevel = (
  sweep: Sweep,
  inlines: readonly Inline[],
  offset: number,
  [from, to]: readonly [number, number],
): Inline[] => {
  if (from === to) {
    return [...inlines];
  }
  const out: Inline[] = [];
  let index = 0;
  let carried: Inline | undefined;
  const take = (): Inline | undefined => {
    const node = carried ?? inlines[index];
    if (carried === undefined) {
      index += 1;
    }
    carried = undefined;
    return node;
  };
  let at = offset;
  let current = from;
  for (let node = take(); node !== undefined; node = take()) {
    chargeWork(sweep.budget, 1);
    const span = current < to ? sweep.spans[current] : undefined;
    const end = at + widthOf(sweep, node);
    if (span === undefined || end === at || span.start >= end) {
      out.push(node);
      at = end;
      continue;
    }
    if (hasInlineChildren(node) && span.end <= end) {
      let last = current;
      while (last < to && (sweep.spans[last]?.end ?? end + 1) <= end) {
        last += 1;
      }
      const crossing = last < to ? sweep.spans[last] : undefined;
      if (crossing !== undefined && crossing.start < end) {
        const [head, tail] = splitAt(sweep, node, at, {
          point: crossing.start,
          zeroSide: "left",
        });
        out.push(
          hasInlineChildren(head)
            ? {
                ...head,
                children: wrapLevel(sweep, head.children, at, [current, last]),
              }
            : head,
        );
        carried = tail;
        at = crossing.start;
      } else {
        out.push({
          ...node,
          children: wrapLevel(sweep, node.children, at, [current, last]),
        });
        at = end;
      }
      current = last;
      continue;
    }
    if (span.start > at) {
      const [head, tail] = splitAt(sweep, node, at, {
        point: span.start,
        zeroSide: "left",
      });
      out.push(head);
      carried = tail;
      at = span.start;
      continue;
    }
    const inside: Inline[] = [];
    for (let piece: Inline | undefined = node; ; piece = take()) {
      if (piece === undefined) {
        return panic("A span runs past the run that holds it");
      }
      chargeWork(sweep.budget, 1);
      const pieceEnd = at + widthOf(sweep, piece);
      if (pieceEnd > span.end) {
        const [head, tail] = splitAt(sweep, piece, at, {
          point: span.end,
          zeroSide: "right",
        });
        inside.push(head);
        carried = tail;
        at = span.end;
        break;
      }
      inside.push(piece);
      at = pieceEnd;
      // Zero-width nodes on the closing edge stay outside.
      if (at >= span.end) {
        break;
      }
    }
    out.push(wrapperOf(sweep, span, inside));
    current += 1;
  }
  return out;
};

const annotateRun = (
  budget: CitationWorkBudget,
  inlines: readonly Inline[],
  occurrences: readonly UsCitationOccurrence[],
): Inline[] => {
  const sweep: Sweep = {
    spans: occurrences.map((occurrence) => ({
      start: occurrence.start,
      end: occurrence.end,
      occurrence,
      hrefs: new Set<string | null>(),
    })),
    text: plainTextOf(inlines),
    budget,
    widths: new WeakMap(),
    next: 0,
  };
  const dissolved = dissolveWrappers(sweep, inlines, 0);
  return wrapLevel(sweep, dissolved, 0, [0, sweep.spans.length]);
};

const runKey = (blockId: string, cell: UsCitationOccurrence["cell"]): string =>
  cell === undefined
    ? blockId
    : `${blockId}\u0000${String(cell.row)}:${String(cell.column)}`;

const annotateBlock = (
  budget: CitationWorkBudget,
  block: Block,
  byRun: ReadonlyMap<string, UsCitationOccurrence[]>,
): Block => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return {
        ...block,
        inlines: annotateRun(
          budget,
          block.inlines,
          byRun.get(runKey(block.id, undefined)) ?? [],
        ),
      };
    case "table":
      return {
        ...block,
        rows: block.rows.map((cells, row) =>
          cells.map((cell, column) => ({
            ...cell,
            inlines: annotateRun(
              budget,
              cell.inlines,
              byRun.get(runKey(block.id, { row, column })) ?? [],
            ),
          })),
        ),
      };
    case "image":
      return block;
    default: {
      block satisfies never;
      return panic("Unhandled block type");
    }
  }
};

/** Occurrences must be in source order, as the occurrence pass emits them. */
export const annotateUsCitations = (
  ast: DocumentAst,
  occurrences: readonly UsCitationOccurrence[],
  budget: CitationWorkBudget,
): Result<DocumentAst, UsCitationWorkBudgetError> => {
  const byRun = new Map<string, UsCitationOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = runKey(occurrence.blockId, occurrence.cell);
    const run = byRun.get(key);
    if (run === undefined) {
      byRun.set(key, [occurrence]);
    } else {
      run.push(occurrence);
    }
  }
  const blocks: Block[] = [];
  for (const block of ast.blocks) {
    blocks.push(annotateBlock(budget, block, byRun));
    if (budget.spent > budget.limit) {
      return Result.err(workBudgetExhausted(budget));
    }
  }
  return Result.ok({ ...ast, blocks });
};
