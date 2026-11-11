/**
 * The graph drawn: four columns from the reading start (documents, their
 * claims, the facts, the sources), links as curves between them in the
 * hue of what they say, and every node a control that focuses its
 * neighbourhood. Drawn by us in SVG and HTML, from `layoutGraph`: no
 * simulation, so the same graph is always the same picture. The columns
 * mirror under a right-to-left language.
 *
 * Pointer-only: the list form beside it is the same model for the keyboard
 * and screen readers, so the canvas stays out of the accessibility tree.
 */

import * as React from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckIcon, FileTextIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { useFactDateText } from "@/features/avt/fact-date";
import type {
  GraphCitation,
  GraphFactTier,
  GraphLayout,
  GraphModel,
  GraphNodeRef,
  Neighbourhood,
  NodeBox,
} from "@/features/avt/graph/graph-model.logic";
import {
  citationKey,
  nodeKey,
  provenanceEdgeKey,
} from "@/features/avt/graph/graph-model.logic";
import { RECORD_CONFLICT_VAR, stateHue } from "@/features/avt/state-chip";
import { REVIEW_STATUS_META } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

/** A footing other than a document's record names itself on the node. */
export const TIER_LABEL_KEYS = {
  testimony: "avt.factTier.testimony.label",
  unsourced: "avt.factTier.unsourced.label",
} as const satisfies Record<Exclude<GraphFactTier, "document">, TranslationKey>;

/** Space between columns, where the links run. */
const GUTTER = 64;
/** Below this the columns stop shrinking and the canvas scrolls sideways
 *  inside its frame; narrower screens get the list form instead. */
export const CANVAS_MIN_WIDTH = 880;
/** Rows drawn above and below the visible part of a long column. */
const OVERSCAN = 480;
/** The column labels' row, above the first node. */
const HEADER_HEIGHT = 32;

const COLUMN_SHARES = {
  statement: 0.17,
  claim: 0.31,
  fact: 0.33,
  source: 0.19,
} as const;

type Column = { x: number; width: number };
type Columns = Record<keyof typeof COLUMN_SHARES, Column> & { total: number };

/** Where each column starts and how wide it is, from the reading start. */
export const columnsFor = (available: number): Columns => {
  const total = Math.max(available, CANVAS_MIN_WIDTH);
  const content = total - 3 * GUTTER;
  let x = 0;
  const place = (share: number): Column => {
    const column = { x, width: Math.floor(content * share) };
    x += column.width + GUTTER;
    return column;
  };
  return {
    statement: place(COLUMN_SHARES.statement),
    claim: place(COLUMN_SHARES.claim),
    fact: place(COLUMN_SHARES.fact),
    source: place(COLUMN_SHARES.source),
    total,
  };
};

/** How a link reads: its hue, and a dotted or dashed line where it says
 *  less than a citation does. */
export const citationStroke = (edge: GraphCitation) => {
  switch (edge.type) {
    case "cites": {
      switch (edge.rel) {
        case "supports": {
          return { color: stateHue("supported"), dash: undefined };
        }
        case "conflicts": {
          return { color: stateHue("contradicted"), dash: undefined };
        }
        case "record": {
          return { color: stateHue("nocover"), dash: "2 3" };
        }
        default: {
          edge.rel satisfies never;
          return panic(`Unhandled citation relation: ${String(edge.rel)}`);
        }
      }
    }
    case "record-conflict": {
      return {
        color: RECORD_CONFLICT_VAR,
        dash: edge.governs ? undefined : "5 3",
      };
    }
    default: {
      edge satisfies never;
      return panic(`Unhandled citation: ${String(edge)}`);
    }
  }
};

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const bend = (x1 + x2) / 2;
  return `M ${String(x1)} ${String(y1)} C ${String(bend)} ${String(y1)}, ${String(bend)} ${String(y2)}, ${String(x2)} ${String(y2)}`;
};

type GraphCanvasProps = {
  model: GraphModel;
  layout: GraphLayout;
  width: number;
  /** The visible band of the frame, for drawing only what can be seen;
   *  null draws everything. */
  viewport: { top: number; height: number } | null;
  focus: GraphNodeRef | null;
  neighbourhood: Neighbourhood | null;
  onNode: (ref: GraphNodeRef) => void;
};

export const GraphCanvas = ({
  model,
  layout,
  width,
  viewport,
  focus,
  neighbourhood,
  onNode,
}: GraphCanvasProps) => {
  const t = useTranslations();
  const dateText = useFactDateText();
  const columns = columnsFor(width);
  const height = layout.height + HEADER_HEIGHT;

  const visible = (box: NodeBox | undefined) =>
    box !== undefined &&
    (viewport === null ||
      (box.y + HEADER_HEIGHT + box.height >= viewport.top - OVERSCAN &&
        box.y + HEADER_HEIGHT <= viewport.top + viewport.height + OVERSCAN));
  const boxOf = (ref: GraphNodeRef) => layout.boxes.get(nodeKey(ref));
  const lit = (key: string) =>
    neighbourhood === null || neighbourhood.nodes.has(key);
  const edgeLit = (key: string) =>
    neighbourhood === null || neighbourhood.edges.has(key);
  const isFocus = (ref: GraphNodeRef) =>
    focus !== null && focus.kind === ref.kind && focus.id === ref.id;

  const centreY = (box: NodeBox) => HEADER_HEIGHT + box.y + box.height / 2;

  const citationPaths = model.citations.flatMap((edge) => {
    const from = boxOf({ kind: "claim", id: edge.claimId });
    const to = boxOf({ kind: "fact", id: edge.factId });
    if (from === undefined || to === undefined) {
      return [];
    }
    if (!visible(from) && !visible(to)) {
      return [];
    }
    const key = citationKey(edge);
    const { color, dash } = citationStroke(edge);
    return [
      <path
        d={curve(
          columns.claim.x + columns.claim.width,
          centreY(from),
          columns.fact.x,
          centreY(to),
        )}
        data-edge={key}
        fill="none"
        key={key}
        opacity={edgeLit(key) ? 0.9 : 0.12}
        stroke={color}
        strokeDasharray={dash}
        strokeWidth={edgeLit(key) && neighbourhood !== null ? 2 : 1.25}
      />,
    ];
  });

  const provenancePaths = model.provenance.flatMap((edge) => {
    const from = boxOf({ kind: "fact", id: edge.factId });
    const to = boxOf({ kind: "source", id: edge.sourceId });
    if (from === undefined || to === undefined) {
      return [];
    }
    if (!visible(from) && !visible(to)) {
      return [];
    }
    const key = provenanceEdgeKey(edge);
    return [
      <path
        className="stroke-muted-foreground"
        d={curve(
          columns.fact.x + columns.fact.width,
          centreY(from),
          columns.source.x,
          centreY(to),
        )}
        fill="none"
        key={`${key}|${JSON.stringify(edge.locator)}`}
        opacity={edgeLit(key) ? 0.45 : 0.08}
        strokeWidth={1}
      />,
    ];
  });

  return (
    <div
      aria-hidden="true"
      className="relative"
      data-testid="avt-graph-canvas"
      style={{ width: columns.total, height }}
    >
      <ColumnLabels columns={columns} model={model} />
      <svg
        className="pointer-events-none absolute inset-0 rtl:-scale-x-100"
        height={height}
        width={columns.total}
      >
        {provenancePaths}
        {citationPaths}
      </svg>

      {layout.columns.statements.map((statement) => {
        const ref = { kind: "statement", id: statement.id } as const;
        const key = nodeKey(ref);
        const box = boxOf(ref);
        if (box === undefined || !visible(box)) {
          return null;
        }
        return (
          <div
            className="absolute flex gap-2"
            key={key}
            style={{
              insetInlineStart: columns.statement.x,
              top: HEADER_HEIGHT + box.y,
              width: columns.statement.width,
              height: box.height,
            }}
          >
            <Button
              className="min-w-0 flex-1 self-start"
              data-dimmed={lit(key) ? undefined : "true"}
              data-node={key}
              onClick={() => onNode(ref)}
              tabIndex={-1}
              variant="plain"
            >
              <span
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-start text-xs transition-opacity duration-150 select-none",
                  "hover:bg-muted/60",
                  isFocus(ref) && "bg-muted",
                  !lit(key) && "opacity-25",
                )}
              >
                <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">
                  {statement.name}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {t("avt.graph.claimCount", { count: statement.claimCount })}
                </span>
              </span>
            </Button>
            {/* The document spans its claims: a bracket, not a link. */}
            <span
              aria-hidden="true"
              className={cn(
                "border-border w-2 shrink-0 rounded-e-sm border-y border-e transition-opacity duration-150",
                !lit(key) && "opacity-25",
              )}
            />
          </div>
        );
      })}

      {layout.columns.claims.map((claim) => {
        const ref = { kind: "claim", id: claim.id } as const;
        const key = nodeKey(ref);
        const box = boxOf(ref);
        if (box === undefined || !visible(box)) {
          return null;
        }
        const settled =
          claim.reviewStatus !== null &&
          REVIEW_STATUS_META[claim.reviewStatus].settles;
        return (
          <GraphNode
            box={box}
            column={columns.claim}
            dimmed={!lit(key)}
            focused={isFocus(ref)}
            key={key}
            nodeKey={key}
            onClick={() => onNode(ref)}
            surfaceStyle={{
              borderInlineStartWidth: 3,
              borderInlineStartColor: stateHue(claim.state),
            }}
          >
            <span className="line-clamp-2 leading-snug [overflow-wrap:anywhere]">
              {claim.text}
            </span>
            {settled && (
              <CheckIcon
                aria-hidden="true"
                className="text-muted-foreground absolute end-1.5 bottom-1.5 size-3"
              />
            )}
          </GraphNode>
        );
      })}

      {layout.columns.facts.map((fact) => {
        const ref = { kind: "fact", id: fact.id } as const;
        const key = nodeKey(ref);
        const box = boxOf(ref);
        if (box === undefined || !visible(box)) {
          return null;
        }
        const date =
          fact.occurredOn === null || fact.occurredOnPrecision === null
            ? null
            : dateText(fact.occurredOn, fact.occurredOnPrecision);
        const notes = [
          fact.tier === "document" ? null : t(TIER_LABEL_KEYS[fact.tier]),
          fact.held ? t("avt.graph.held") : null,
          fact.listed ? null : t("avt.graph.offList"),
        ].filter((note) => note !== null);
        return (
          <GraphNode
            box={box}
            column={columns.fact}
            dimmed={!lit(key)}
            focused={isFocus(ref)}
            key={key}
            nodeKey={key}
            onClick={() => onNode(ref)}
            surfaceClassName={cn(
              fact.held && "bg-muted/40 border-dashed",
              !fact.listed && "border-dashed",
            )}
          >
            <span
              className={cn(
                "leading-snug [overflow-wrap:anywhere]",
                notes.length === 0 && date === null
                  ? "line-clamp-2"
                  : "line-clamp-1",
                fact.held && "text-muted-foreground",
              )}
            >
              {fact.text}
            </span>
            {(date !== null || notes.length > 0) && (
              <span className="text-muted-foreground truncate">
                {[date, ...notes].filter((part) => part !== null).join(" · ")}
              </span>
            )}
          </GraphNode>
        );
      })}

      {layout.columns.sources.map((source) => {
        const ref = { kind: "source", id: source.id } as const;
        const key = nodeKey(ref);
        const box = boxOf(ref);
        if (box === undefined || !visible(box)) {
          return null;
        }
        return (
          <GraphNode
            box={box}
            column={columns.source}
            dimmed={!lit(key)}
            focused={isFocus(ref)}
            key={key}
            nodeKey={key}
            onClick={() => onNode(ref)}
            surfaceClassName="flex-row items-center gap-1.5"
          >
            <FileTextIcon
              aria-hidden="true"
              className="text-muted-foreground size-3.5 shrink-0"
            />
            <span className="truncate">{source.name}</span>
          </GraphNode>
        );
      })}
    </div>
  );
};

type GraphNodeProps = {
  nodeKey: string;
  box: NodeBox;
  column: Column;
  dimmed: boolean;
  focused: boolean;
  onClick: () => void;
  surfaceClassName?: string;
  surfaceStyle?: React.CSSProperties;
  children: React.ReactNode;
};

/** One node: a pointer target placed in its column, and the card it draws. */
const GraphNode = ({
  nodeKey: key,
  box,
  column,
  dimmed,
  focused,
  onClick,
  surfaceClassName,
  surfaceStyle,
  children,
}: GraphNodeProps) => (
  <Button
    className="absolute"
    data-dimmed={dimmed ? "true" : undefined}
    data-node={key}
    onClick={onClick}
    style={{
      insetInlineStart: column.x,
      top: HEADER_HEIGHT + box.y,
      width: column.width,
      height: box.height,
    }}
    tabIndex={-1}
    variant="plain"
  >
    <span
      className={cn(
        "bg-card relative flex size-full min-w-0 flex-col justify-center overflow-hidden rounded-md border px-2.5 text-start text-xs shadow-xs transition-[opacity,border-color,box-shadow] duration-150 select-none",
        "hover:border-ring",
        dimmed && "opacity-25",
        focused && "border-ring ring-ring/40 ring-2",
        surfaceClassName,
      )}
      style={surfaceStyle}
    >
      {children}
    </span>
  </Button>
);

const ColumnLabels = ({
  columns,
  model,
}: {
  columns: Columns;
  model: GraphModel;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const labels = [
    {
      key: "statement",
      column: columns.statement,
      label: t("avt.graph.columns.statements"),
      count: model.statements.length,
    },
    {
      key: "claim",
      column: columns.claim,
      label: t("avt.graph.columns.claims"),
      count: model.claims.length,
    },
    {
      key: "fact",
      column: columns.fact,
      label: t("avt.anchorFacts.title"),
      count: model.facts.length,
    },
    {
      key: "source",
      column: columns.source,
      label: t("avt.graph.columns.sources"),
      count: model.sources.length,
    },
  ] as const;
  return (
    <>
      {labels.map(({ key, column, label, count }) => (
        <div
          className="text-muted-foreground absolute top-0 flex items-baseline gap-1.5 px-1.5 text-xs font-medium"
          key={key}
          style={{ insetInlineStart: column.x, width: column.width }}
        >
          <span>{label}</span>
          <span className="tabular-nums opacity-70">
            {format.number(count)}
          </span>
        </div>
      ))}
    </>
  );
};
