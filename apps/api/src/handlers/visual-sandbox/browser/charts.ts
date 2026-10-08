import { defineChart } from "@tanstack/charts";
import { mountChart } from "@tanstack/charts/dom";
import { treemap } from "@tanstack/charts/hierarchy/treemap";
import { panic } from "better-result";
import { scaleLinear, scaleOrdinal } from "d3-scale";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";

import {
  createTreemapModel,
  createTreemapNumberFormatter,
  localizedTierLabel,
  treemapCategoryValue,
  treemapColorDomain,
  type VisualColorMode,
  type VisualTreemapColor,
  type VisualTreemapTree,
} from "./treemap-model";

export type VisualTreemapOptions = {
  data: VisualTreemapTree;
  value: "count";
  color: VisualTreemapColor;
  onSelect?: (node: VisualTreemapTree) => void;
};

const readChartColors = (win: Window, el: HTMLElement) => {
  const style = win.getComputedStyle(el);
  const token = (name: string) => {
    const value = style.getPropertyValue(name).trim();
    if (!value) {
      panic(`Missing visual chart token: ${name}`);
    }
    return value;
  };
  return {
    background: token("--background"),
    foreground: token("--foreground"),
    muted: token("--muted"),
    border: token("--border"),
    primaryForeground: token("--primary-foreground"),
    palette: Array.from({ length: 8 }, (_, index) =>
      token(`--chart-${index + 1}`),
    ),
    primary: token("--chart-1"),
    negative: token("--chart-6"),
    positive: token("--chart-2"),
  };
};

type ChartColors = ReturnType<typeof readChartColors>;

type NumericColorsOptions = {
  mode: VisualColorMode;
  domain: readonly [number, number];
  colors: ChartColors;
};

const createNumericColors = ({
  mode,
  domain,
  colors,
}: NumericColorsOptions) => {
  const intensity = scaleLinear()
    .domain(domain)
    .range(mode === "citations" ? [0, 1] : [-1, 1])
    .clamp(true);
  const numericFill = (value: number | null) => {
    if (value === null) {
      return colors.muted;
    }
    // A collapsed domain represents a constant zero, not the scale's midpoint.
    const amount = domain[0] === domain[1] ? 0 : intensity(value);
    let endpoint: string = colors.primary;
    if (mode !== "citations") {
      endpoint = amount < 0 ? colors.negative : colors.positive;
    }
    const weight = Math.abs(amount) * (mode === "citations" ? 100 : 45);
    return `color-mix(in srgb, ${colors.background}, ${endpoint} ${weight}%)`;
  };
  return { intensity, numericFill };
};

type RenderLegendOptions = {
  legend: HTMLElement;
  mode: VisualColorMode;
  categoryField: VisualTreemapColor["field"] | null;
  categories: string[];
  categoryScale: (category: string) => string;
  numericFill: (value: number | null) => string;
  domain: readonly [number, number];
  unknown: boolean;
  language: string;
  rtl: boolean;
  colors: ChartColors;
};

const renderTreemapLegend = ({
  legend,
  mode,
  categoryField,
  categories,
  categoryScale,
  numericFill,
  domain,
  unknown,
  language,
  rtl,
  colors,
}: RenderLegendOptions) => {
  const owner = legend.ownerDocument;
  legend.replaceChildren();
  Object.assign(legend.dataset, { colorMode: mode });
  if (mode === "category") {
    for (const category of categories) {
      const item = owner.createElement("span");
      const swatch = owner.createElement("span");
      swatch.style.cssText =
        "display:inline-block;inline-size:0.75rem;block-size:0.75rem;margin-inline-end:0.25rem;border-radius:0.125rem";
      swatch.style.background = categoryScale(category);
      item.append(
        swatch,
        owner.createTextNode(
          categoryField === "tier"
            ? localizedTierLabel(language, category)
            : category,
        ),
      );
      legend.append(item);
    }
    return;
  }
  const formatter = createTreemapNumberFormatter(language);
  const low = owner.createElement("span");
  const ramp = owner.createElement("span");
  const high = owner.createElement("span");
  low.textContent = unknown ? "—" : formatter.format(domain[0]);
  high.textContent = unknown ? "—" : formatter.format(domain[1]);
  ramp.style.cssText =
    "display:block;flex:1;block-size:0.5rem;border-radius:0.25rem";
  const direction = rtl ? "to left" : "to right";
  ramp.style.background = unknown
    ? colors.muted
    : `linear-gradient(${direction}, ${numericFill(domain[0])}, ${numericFill((domain[0] + domain[1]) / 2)}, ${numericFill(domain[1])})`;
  legend.append(low, ramp, high);
};

type MountTreemapOptions = {
  win: Window;
  el: HTMLElement;
  opts: VisualTreemapOptions;
};

const treemapCategories = (
  model: ReturnType<typeof createTreemapModel>,
  categoryField: VisualTreemapColor["field"] | null,
): string[] => {
  if (categoryField === "tier") {
    return [...COURT_TIER_LABELS];
  }
  if (categoryField === null) {
    return [];
  }
  return [
    ...new Set(
      model
        .nodes()
        .map((node) => treemapCategoryValue(node, categoryField))
        .filter((value) => value !== null),
    ),
  ];
};

const createTreemapLayout = (owner: Document, showLegend: boolean) => {
  const layout = owner.createElement("div");
  const surface = owner.createElement("div");
  const legend = owner.createElement("div");
  // The fixed chart height includes a wrapping legend. Flex sizing gives
  // the surface the remaining space; unsized containers keep the aspect ratio.
  layout.style.cssText =
    "display:flex;flex-direction:column;inline-size:100%;block-size:100%;min-block-size:0";
  surface.style.cssText =
    "flex:1;inline-size:100%;block-size:100%;min-block-size:0;aspect-ratio:16/9";
  legend.style.cssText =
    "display:flex;flex-shrink:0;align-items:center;flex-wrap:wrap;gap:0.5rem;font-variant-numeric:tabular-nums;margin-block-start:0.5rem;color:inherit";
  layout.append(surface);
  if (showLegend) {
    layout.append(legend);
  }
  return { layout, surface, legend };
};

const mountTreemap = ({ win, el, opts }: MountTreemapOptions) => {
  if (el.ownerDocument !== win.document) {
    panic("Treemap container must belong to its runtime document");
  }
  const model = createTreemapModel(opts.data);
  let mode = opts.color.mode;
  // Switching into category mode requires an explicitly authored field.
  const categoryField = opts.color.field ?? null;
  const categories = treemapCategories(model, categoryField);
  let destroyed = false;
  const owner = win.document;
  const { layout, surface, legend } = createTreemapLayout(
    owner,
    opts.color.legend,
  );
  el.append(layout);
  const language =
    el.closest("[lang]")?.getAttribute("lang") ||
    owner.documentElement.lang ||
    win.navigator.language;
  const config = () => {
    const colors = readChartColors(win, el);
    const categoryScale = scaleOrdinal(categories, colors.palette).unknown(
      colors.muted,
    );
    const colorScheme = win.getComputedStyle(el).colorScheme;
    surface.style.colorScheme = colorScheme;
    surface.style.color = colors.foreground;
    legend.style.colorScheme = colorScheme;
    legend.style.color = colors.foreground;
    const rows = model.visible();
    const domain =
      mode === "category" ? ([0, 0] as const) : treemapColorDomain(rows, mode);
    const { intensity, numericFill } = createNumericColors({
      mode,
      domain,
      colors,
    });
    const rowFill = (row: (typeof rows)[number]) => {
      if (mode !== "category") {
        return numericFill(
          mode === "citations" ? row.citationSum : row.treatment,
        );
      }
      if (categoryField === null) {
        panic("Category color mode requires a field");
      }
      const category = treemapCategoryValue(row.node, categoryField);
      return category === null ? colors.muted : categoryScale(category);
    };
    if (opts.color.legend) {
      renderTreemapLegend({
        legend,
        mode,
        categoryField,
        categories,
        categoryScale,
        numericFill,
        domain,
        unknown:
          rows.length > 0 &&
          rows.every(
            (row) =>
              (mode === "citations" ? row.citationSum : row.treatment) === null,
          ),
        language,
        rtl: win.getComputedStyle(el).direction === "rtl",
        colors,
      });
    }
    const tiles = [
      {
        node: model.root(),
        count: 0,
        citationSum: 0,
        treatment: null,
        parentId: null,
        id: "root",
      },
      ...rows.map((row) => ({
        ...row,
        parentId: "root",
        id: `child:${row.node.id}`,
      })),
    ];
    return {
      definition: defineChart({
        marks: [
          treemap(tiles, {
            nodeId: "id",
            parentId: "parentId",
            value: "count",
            fill: ({ data }) => (data ? rowFill(data) : colors.muted),
            label: ({ data }) => data?.node.label,
            labelFill: ({ data }) =>
              mode === "citations" &&
              data &&
              data.citationSum !== null &&
              domain[1] > 0 &&
              intensity(data.citationSum) > 0.55
                ? colors.primaryForeground
                : colors.foreground,
            stroke: colors.border,
            paddingInner: 2,
            inset: 1,
            labelPadding: 6,
            labelFontSize: 12,
            states: [
              {
                when: { focus: "primary" },
                style: { stroke: colors.foreground, strokeWidth: 2 },
              },
            ],
          }),
        ],
        scales: { x: null, y: null },
        guides: false,
        margin: 0,
        theme: {
          foreground: colors.foreground,
          background: colors.background,
          muted: colors.muted,
          grid: colors.border,
          palette: colors.palette,
        },
      }),
      ariaLabel: model.root().label,
      aspectRatio: 16 / 9,
    };
  };
  const host = mountChart(surface, config());
  type SelectionPoint = Parameters<
    NonNullable<Parameters<typeof host.update>[0]["onSelect"]>
  >[0];
  const onSelect = (point: SelectionPoint) => {
    if (!point?.datum.data || point.datum.data.parentId === null || destroyed) {
      return;
    }
    const selected = model.select(point.datum.data.node.id);
    host.update({ ...config(), onSelect });
    opts.onSelect?.(selected);
  };
  host.update({ ...config(), onSelect });
  const back = () => {
    if (destroyed || !model.back()) {
      return;
    }
    host.update({ ...config(), onSelect });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    back();
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    back();
  };
  const onThemeChange = () => {
    if (!destroyed) {
      host.update({ ...config(), onSelect });
    }
  };
  win.addEventListener("stella-theme-change", onThemeChange);
  surface.addEventListener("keydown", onKeyDown);
  surface.addEventListener("contextmenu", onContextMenu);
  return Object.freeze({
    setColorMode: (next: VisualColorMode) => {
      if (destroyed) {
        return;
      }
      if (next === "category" && categoryField === null) {
        panic(
          "Category color mode requires a field in the initial configuration",
        );
      }
      mode = next;
      host.update({ ...config(), onSelect });
    },
    destroy: () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      win.removeEventListener("stella-theme-change", onThemeChange);
      surface.removeEventListener("keydown", onKeyDown);
      surface.removeEventListener("contextmenu", onContextMenu);
      host.destroy();
      layout.remove();
    },
  });
};

export const createVisualCharts = (win: Window) =>
  Object.freeze({
    treemap: (el: HTMLElement, opts: VisualTreemapOptions) =>
      mountTreemap({ win, el, opts }),
  });
