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

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CheckIcon, FileTextIcon } from "@stll/ui/icons";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { SourceLocatorLabel } from "@/components/workspaces/list-source";
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
/** Rows drawn above and below the visible part of a long column. */
const OVERSCAN = 480;
/** The column labels' row, above the first node. */
const HEADER_HEIGHT = 32;

/**
 * The columns' shares of the width, and the width below which they stop
 * shrinking and the canvas scrolls sideways inside its frame (narrower
 * screens get the list form instead). One document needs no column of its
 * own: it heads the claims.
 */
const COLUMN_PLANS = {
  documents: {
    minWidth: 880,
    shares: { statement: 0.15, claim: 0.3, fact: 0.32, source: 0.23 },
  },
  single: {
    minWidth: 620,
    shares: { statement: 0, claim: 0.36, fact: 0.38, source: 0.26 },
  },
} as const;

type Column = { x: number; width: number };
type Columns = Record<
  keyof (typeof COLUMN_PLANS)["documents"]["shares"],
  Column
> & { total: number };

/** Where each column starts and how wide it is, from the reading start. */
const columnsFor = (
  available: number,
  plan: keyof typeof COLUMN_PLANS,
): Columns => {
  const { minWidth, shares } = COLUMN_PLANS[plan];
  const drawn = Object.values(shares).filter((share) => share > 0).length;
  const total = Math.max(available, minWidth);
  const content = total - (drawn - 1) * GUTTER;
  let x = 0;
  const place = (share: number): Column => {
    if (share === 0) {
      return { x, width: 0 };
    }
    const column = { x, width: Math.floor(content * share) };
    x += column.width + GUTTER;
    return column;
  };
  return {
    statement: place(shares.statement),
    claim: place(shares.claim),
    fact: place(shares.fact),
    source: place(shares.source),
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
  const single = layout.columns.statements.length <= 1;
  const columns = columnsFor(width, single ? "single" : "documents");
  const height = layout.height + HEADER_HEIGHT;
  // Each fact names where it comes from on its own card; the links to the
  // sources are drawn only around a focus.
  const sourceNames = new Map(
    model.sources.map((source) => [source.id, source.name]),
  );
  const firstSource = new Map<string, GraphModel["provenance"][number]>();
  const factsPerSource = new Map<string, number>();
  for (const edge of model.provenance) {
    if (!firstSource.has(edge.factId)) {
      firstSource.set(edge.factId, edge);
    }
    factsPerSource.set(
      edge.sourceId,
      (factsPerSource.get(edge.sourceId) ?? 0) + 1,
    );
  }

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
    const key = provenanceEdgeKey(edge);
    if (neighbourhood === null || !neighbourhood.edges.has(key)) {
      return [];
    }
    return [
      <path
        className="stroke-muted-foreground"
        d={curve(
          columns.fact.x + columns.fact.width,
          centreY(from),
          columns.source.x,
          centreY(to),
        )}
        data-provenance={key}
        fill="none"
        key={`${key}|${JSON.stringify(edge.locator)}`}
        opacity={0.6}
        strokeWidth={1.25}
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
      <ColumnLabels columns={columns} model={model} single={single} />
      <svg
        className="pointer-events-none absolute inset-0 rtl:-scale-x-100"
        height={height}
        width={columns.total}
      >
        {provenancePaths}
        {citationPaths}
      </svg>

      {!single &&
        layout.columns.statements.map((statement) => {
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
                  <TruncatedText
                    className="font-medium"
                    lines={2}
                    render={<BidiText as="span" />}
                  >
                    {statement.name}
                  </TruncatedText>
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
            <TruncatedText
              className="leading-snug"
              lines={2}
              render={<BidiText as="span" />}
            >
              {claim.text}
            </TruncatedText>
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
        const source = firstSource.get(fact.id);
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
            <FactCardText
              fact={fact}
              source={
                source === undefined
                  ? null
                  : {
                      name: sourceNames.get(source.sourceId) ?? null,
                      locator: source.locator,
                    }
              }
            />
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
            surfaceClassName="flex-row items-center gap-2"
          >
            <FileTextIcon
              aria-hidden="true"
              className="text-muted-foreground size-3.5 shrink-0"
            />
            <span className="flex min-w-0 flex-col">
              <TruncatedText render={<BidiText as="span" />}>
                {source.name}
              </TruncatedText>
              <span className="text-muted-foreground tabular-nums">
                {t("avt.graph.factCount", {
                  count: factsPerSource.get(source.id) ?? 0,
                })}
              </span>
            </span>
          </GraphNode>
        );
      })}
    </div>
  );
};

type FactCardTextProps = {
  fact: GraphModel["facts"][number];
  source: {
    name: string | null;
    locator: GraphModel["provenance"][number]["locator"];
  } | null;
};

/** A fact's words, then one muted line: when it happened, where it comes
 *  from, and what qualifies it. */
const FactCardText = ({ fact, source }: FactCardTextProps) => {
  const t = useTranslations();
  const dateText = useFactDateText();
  const date =
    fact.occurredOn === null || fact.occurredOnPrecision === null
      ? null
      : dateText(fact.occurredOn, fact.occurredOnPrecision);
  const notes = [
    fact.tier === "document" ? null : t(TIER_LABEL_KEYS[fact.tier]),
    fact.held ? t("avt.graph.held") : null,
    fact.listed ? null : t("avt.graph.offList"),
  ].filter((note) => note !== null);
  const details: { key: string; content: React.ReactNode }[] = [
    ...(date === null ? [] : [{ key: "date", content: date }]),
    ...(source === null
      ? []
      : [
          {
            key: "source",
            content: (
              <SourceLocatorLabel
                documentName={source.name}
                locator={source.locator}
              />
            ),
          },
        ]),
    ...notes.map((note) => ({ key: note, content: note })),
  ];
  return (
    <>
      <TruncatedText
        className={cn("leading-snug", fact.held && "text-muted-foreground")}
        lines={details.length === 0 ? 2 : 1}
        render={<BidiText as="span" />}
      >
        {fact.text}
      </TruncatedText>
      {details.length > 0 && (
        <TruncatedText className="text-muted-foreground">
          {details.map(({ key, content }, index) => (
            <React.Fragment key={key}>
              {index > 0 && " · "}
              {content}
            </React.Fragment>
          ))}
        </TruncatedText>
      )}
    </>
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
        "bg-card relative flex size-full min-w-0 flex-col justify-center overflow-hidden rounded-md border px-2.5 text-start text-xs shadow-xs transition-opacity duration-150 select-none",
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
  single,
}: {
  columns: Columns;
  model: GraphModel;
  /** One document heads the claims instead of a column of its own. */
  single: boolean;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const statement = model.statements.at(0);
  const labels = [
    ...(single
      ? []
      : [
          {
            key: "statement",
            column: columns.statement,
            label: t("avt.graph.columns.statements"),
            tally: format.number(model.statements.length),
          },
        ]),
    single && statement !== undefined
      ? {
          key: "claim",
          column: columns.claim,
          label: statement.name,
          tally: t("avt.graph.claimCount", { count: model.claims.length }),
        }
      : {
          key: "claim",
          column: columns.claim,
          label: t("avt.graph.columns.claims"),
          tally: format.number(model.claims.length),
        },
    {
      key: "fact",
      column: columns.fact,
      label: t("avt.anchorFacts.title"),
      tally: format.number(model.facts.length),
    },
    {
      key: "source",
      column: columns.source,
      label: t("avt.graph.columns.sources"),
      tally: format.number(model.sources.length),
    },
  ];
  return (
    <>
      {labels.map(({ key, column, label, tally }) => (
        <div
          className="text-muted-foreground absolute top-0 flex min-w-0 items-baseline gap-1.5 px-1.5 text-xs font-medium"
          key={key}
          style={{ insetInlineStart: column.x, width: column.width }}
        >
          <TruncatedText render={<BidiText as="span" />}>{label}</TruncatedText>
          <span className="shrink-0 tabular-nums opacity-70">{tally}</span>
        </div>
      ))}
    </>
  );
};
