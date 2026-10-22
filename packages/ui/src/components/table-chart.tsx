"use client";

import { useId } from "react";

import { panic } from "better-result";

export type TableChartKind = "bar" | "line" | "pie" | "scatter";

export type TableChartPoint = {
  label: string;
  x: number;
  y: number;
  series?: string;
};

export type TableChartProps = {
  kind: TableChartKind;
  points: readonly TableChartPoint[];
  title: string;
  summary: string;
  xLabel?: string | undefined;
  yLabel?: string | undefined;
  xMode?: "numeric" | "category";
  formatNumber: (value: number) => string;
};

const WIDTH = 640;
const HEIGHT = 360;
const PLOT = { x: 76, y: 24, width: 540, height: 260 };
const MAX_POINTS = 500;
const TICK_COUNT = 4;
const PALETTE_SIZE = 8;

// Normalize before subtracting so even finite values at opposite numeric
// extremes cannot overflow their domain span.
const scale = (values: readonly number[], includeZero: boolean) => {
  const magnitude = Math.max(1, ...values.map((value) => Math.abs(value)));
  const normalized = values.map((value) => value / magnitude);
  let low = Math.min(...normalized, ...(includeZero ? [0] : []));
  let high = Math.max(...normalized, ...(includeZero ? [0] : []));
  if (low === high) {
    low = Math.min(0, low);
    high = Math.max(0, high);
    if (low === high) {
      low = -1;
      high = 1;
    }
  }
  return {
    position: (value: number) => (value / magnitude - low) / (high - low),
    tick: (index: number) =>
      (low + ((high - low) * index) / TICK_COUNT) * magnitude,
  };
};

const color = (index: number) => `var(--chart-${(index % PALETTE_SIZE) + 1})`;

const identifyPoints = (points: readonly TableChartPoint[]) => {
  const occurrences = new Map<string, number>();
  return points.map((point) => {
    const identity = JSON.stringify([
      point.label,
      point.x,
      point.y,
      point.series,
    ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { point, key: `${identity}:${occurrence}` };
  });
};

type PlotProps = Pick<
  TableChartProps,
  "kind" | "points" | "formatNumber" | "xMode"
>;

const CartesianPlot = ({
  kind,
  points,
  formatNumber,
  xMode = "numeric",
}: PlotProps) => {
  const xScale = scale(
    points.map(({ x }) => x),
    false,
  );
  const yScale = scale(
    points.map(({ y }) => y),
    kind === "bar",
  );
  const x = (value: number) => PLOT.x + xScale.position(value) * PLOT.width;
  const y = (value: number) =>
    PLOT.y + (1 - yScale.position(value)) * PLOT.height;
  const keyedPoints = identifyPoints(points);
  const groups = Map.groupBy(keyedPoints, ({ point }) => point.series ?? "");
  const seriesNames = [...groups.keys()];
  const barStep = PLOT.width / points.length;
  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  const categories = [
    ...new Map(points.map((point) => [point.x, point] as const)).values(),
  ];
  const categoryStep = Math.max(1, Math.ceil(categories.length / 8));

  return (
    <>
      {Array.from({ length: TICK_COUNT + 1 }, (_, index) => {
        const value = yScale.tick(index);
        const ordinate = PLOT.y + (1 - index / TICK_COUNT) * PLOT.height;
        return (
          <g key={index} data-slot="chart-y-tick">
            <line
              x1={PLOT.x}
              x2={PLOT.x + PLOT.width}
              y1={ordinate}
              y2={ordinate}
              stroke="var(--border)"
            />
            <text
              x={PLOT.x - 8}
              y={ordinate + 4}
              textAnchor="end"
              fill="var(--muted-foreground)"
            >
              {formatNumber(value)}
            </text>
          </g>
        );
      })}
      <path
        data-slot="chart-axis"
        d={`M ${PLOT.x} ${PLOT.y} V ${PLOT.y + PLOT.height} H ${PLOT.x + PLOT.width}`}
        fill="none"
        stroke="var(--muted-foreground)"
      />
      {kind === "bar" ? (
        <>
          <line
            data-slot="chart-zero"
            x1={PLOT.x}
            x2={PLOT.x + PLOT.width}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--muted-foreground)"
          />
          {keyedPoints.map(({ point, key }, index) => (
            <g key={key}>
              <rect
                data-slot="chart-bar"
                x={PLOT.x + index * barStep + barStep * 0.15}
                y={Math.min(y(point.y), y(0))}
                width={barStep * 0.7}
                height={Math.abs(y(point.y) - y(0))}
                fill={color(seriesNames.indexOf(point.series ?? ""))}
              >
                <title>{`${point.label}: ${formatNumber(point.y)}${point.series ? ` (${point.series})` : ""}`}</title>
              </rect>
              {index % labelStep === 0 && (
                <text
                  x={PLOT.x + (index + 0.5) * barStep}
                  y={PLOT.y + PLOT.height + 20}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  style={{ unicodeBidi: "plaintext" }}
                >
                  {point.label.length > 16
                    ? `${point.label.slice(0, 15)}…`
                    : point.label}
                </text>
              )}
            </g>
          ))}
        </>
      ) : (
        <>
          {xMode === "category"
            ? categories
                .filter((_, index) => index % categoryStep === 0)
                .map((point) => (
                  <text
                    key={point.x}
                    data-slot="chart-x-tick"
                    x={x(point.x)}
                    y={PLOT.y + PLOT.height + 20}
                    textAnchor="middle"
                    fill="var(--muted-foreground)"
                    style={{ unicodeBidi: "plaintext" }}
                  >
                    {point.label.length > 16
                      ? `${point.label.slice(0, 15)}…`
                      : point.label}
                  </text>
                ))
            : Array.from({ length: TICK_COUNT + 1 }, (_, index) => (
                <text
                  key={index}
                  data-slot="chart-x-tick"
                  x={PLOT.x + (index / TICK_COUNT) * PLOT.width}
                  y={PLOT.y + PLOT.height + 20}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                >
                  {formatNumber(xScale.tick(index))}
                </text>
              ))}
          {[...groups].map(([name, group], index) => (
            <g key={name}>
              {kind === "line" && (
                <polyline
                  data-slot="chart-line"
                  points={group
                    .map(({ point }) => `${x(point.x)},${y(point.y)}`)
                    .join(" ")}
                  fill="none"
                  stroke={color(index)}
                  strokeWidth={2}
                />
              )}
              {group.map(({ point, key }) => (
                <circle
                  key={key}
                  data-slot="chart-point"
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={4}
                  fill={color(index)}
                >
                  <title>{`${point.label}: ${xMode === "numeric" ? `${formatNumber(point.x)}, ` : ""}${formatNumber(point.y)}${name ? ` (${name})` : ""}`}</title>
                </circle>
              ))}
            </g>
          ))}
        </>
      )}
    </>
  );
};

const PiePlot = ({ points, formatNumber }: Omit<PlotProps, "kind">) => {
  if (points.some(({ y }) => y < 0)) {
    panic("Pie chart values must be nonnegative");
  }
  const magnitude = Math.max(1, ...points.map(({ y }) => y));
  const total = points.reduce((sum, { y }) => sum + y / magnitude, 0);
  const radius = 110;
  const center = { x: WIDTH / 2, y: 155 };
  let angle = -Math.PI / 2;
  const slices = [];
  for (const [index, { point, key }] of identifyPoints(points).entries()) {
    if (point.y === 0 || total === 0) {
      continue;
    }
    const fraction = point.y / magnitude / total;
    const start = angle;
    angle += fraction * Math.PI * 2;
    const path = `M ${center.x} ${center.y} L ${center.x + radius * Math.cos(start)} ${center.y + radius * Math.sin(start)} A ${radius} ${radius} 0 ${fraction > 0.5 ? 1 : 0} 1 ${center.x + radius * Math.cos(angle)} ${center.y + radius * Math.sin(angle)} Z`;
    slices.push({ point, key, index, fraction, path });
  }
  return (
    <>
      <circle cx={center.x} cy={center.y} r={radius} fill="var(--muted)" />
      {slices.map(({ point, key, index, fraction, path }) => {
        if (fraction === 1) {
          return (
            <circle
              key={key}
              data-slot="chart-slice"
              cx={center.x}
              cy={center.y}
              r={radius}
              fill={color(index)}
            >
              <title>{`${point.label}: ${formatNumber(point.y)}`}</title>
            </circle>
          );
        }
        return (
          <path
            key={key}
            data-slot="chart-slice"
            d={path}
            fill={color(index)}
            stroke="var(--background)"
          >
            <title>{`${point.label}: ${formatNumber(point.y)}`}</title>
          </path>
        );
      })}
    </>
  );
};

export const TableChart = ({
  kind,
  points,
  title,
  summary,
  xLabel,
  yLabel,
  xMode = "numeric",
  formatNumber,
}: TableChartProps) => {
  const id = useId();
  if (
    points.length === 0 ||
    points.length > MAX_POINTS ||
    points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))
  ) {
    panic("Chart requires between 1 and 500 finite points");
  }
  const legend = (
    kind === "pie"
      ? points.map(({ label, series }) =>
          series ? `${label} (${series})` : label,
        )
      : [...new Set(points.map(({ series }) => series ?? ""))]
  )
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name.length > 0);
  return (
    <figure
      data-slot="table-chart"
      className="text-foreground min-w-0 space-y-2"
    >
      <p className="text-sm font-medium">
        <bdi>{title}</bdi>
      </p>
      <svg
        role="img"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-summary`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block w-full text-xs tabular-nums"
        direction="ltr"
      >
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-summary`}>{summary}</desc>
        {kind === "pie" ? (
          <PiePlot points={points} formatNumber={formatNumber} />
        ) : (
          <CartesianPlot
            kind={kind}
            points={points}
            formatNumber={formatNumber}
            xMode={xMode}
          />
        )}
        {kind !== "pie" && xLabel && (
          <text
            x={PLOT.x + PLOT.width / 2}
            y={HEIGHT - 16}
            textAnchor="middle"
            fill="var(--foreground)"
            style={{ unicodeBidi: "plaintext" }}
          >
            {xLabel}
          </text>
        )}
        {kind !== "pie" && yLabel && (
          <text
            x={18}
            y={PLOT.y + PLOT.height / 2}
            transform={`rotate(-90 18 ${PLOT.y + PLOT.height / 2})`}
            textAnchor="middle"
            fill="var(--foreground)"
            style={{ unicodeBidi: "plaintext" }}
          >
            {yLabel}
          </text>
        )}
      </svg>
      {legend.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {legend.map(({ name, index }) => (
            <li key={index} className="flex min-w-0 items-center gap-1">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ background: color(index) }}
              />
              <bdi className="wrap-break-word">{name}</bdi>
            </li>
          ))}
        </ul>
      )}
      <figcaption className="text-muted-foreground text-sm">
        <bdi>{summary}</bdi>
      </figcaption>
    </figure>
  );
};
