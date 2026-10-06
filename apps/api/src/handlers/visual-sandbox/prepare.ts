import { panic, Result, TaggedError } from "better-result";
import { load } from "cheerio";

import {
  GENERATED_VISUAL_LIMITS,
  type GeneratedVisualInput,
  type VisualChartSpec,
} from "@stll/api-contract/generated-visual";
import { Temporal } from "@stll/time";

import { sanitizeVisualHtml } from "./sanitize";

export class VisualDefinitionError extends TaggedError(
  "VisualDefinitionError",
)<{
  message: string;
  reason: "chart" | "data";
}> {}

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isChannelValue = (
  channel: VisualChartSpec["x"] | VisualChartSpec["y"],
  value: unknown,
) => {
  switch (channel.type) {
    case "quantitative":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (channel.scale !== "log" || value > 0)
      );
    case "nominal":
      return typeof value === "string";
    case "temporal": {
      if (typeof value !== "string") {
        return false;
      }
      return Result.try({
        try: () => Temporal.Instant.from(value),
        catch: () =>
          new VisualDefinitionError({
            reason: "data",
            message:
              "Use an ISO timestamp with a timezone for temporal chart values.",
          }),
      }).isOk();
    }
    default: {
      channel satisfies never;
      return panic("Unhandled visual chart channel");
    }
  }
};

type UnreferencedDataKeyOptions = {
  data: Record<string, unknown>;
  html: string;
  fields: ReadonlyMap<string, ReadonlySet<string>>;
};
const unreferencedDataKey = ({
  data,
  html,
  fields,
}: UnreferencedDataKeyOptions) => {
  for (const [dataset, value] of Object.entries(data)) {
    const chartFields = fields.get(dataset);
    if (!chartFields && !html.includes(dataset)) {
      return dataset;
    }
    const pending: unknown[] = [value];
    while (pending.length > 0) {
      const current = pending.pop();
      if (Array.isArray(current)) {
        for (const child of current) {
          pending.push(child);
        }
        continue;
      }
      if (!isRow(current)) {
        continue;
      }
      for (const [field, child] of Object.entries(current)) {
        if (!chartFields?.has(field) && !html.includes(field)) {
          return `${dataset}.${field}`;
        }
        pending.push(child);
      }
    }
  }
  return null;
};

export const prepareGeneratedVisual = (input: GeneratedVisualInput) => {
  const normalized = sanitizeVisualHtml(input.html);
  if (normalized.isErr()) {
    return normalized;
  }
  const $ = load(normalized.value);
  const ids = new Set<string>();
  const fields = new Map<string, Set<string>>();
  for (const { id, spec } of input.charts) {
    const containers = $("div[id]").filter(
      (_, element) => $(element).attr("id") === id,
    );
    if (ids.has(id) || containers.length !== 1) {
      return Result.err(
        new VisualDefinitionError({
          reason: "chart",
          message: `Give chart ${id} one unique matching <div id="${id}"> container.`,
        }),
      );
    }
    ids.add(id);
    const rows = input.data[spec.dataset];
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.length > GENERATED_VISUAL_LIMITS.chartRows
    ) {
      return Result.err(
        new VisualDefinitionError({
          reason: "data",
          message: `Provide 1–${GENERATED_VISUAL_LIMITS.chartRows} rows in data.${spec.dataset}.`,
        }),
      );
    }
    for (const row of rows) {
      if (
        !isRow(row) ||
        !isChannelValue(spec.x, row[spec.x.field]) ||
        !isChannelValue(spec.y, row[spec.y.field])
      ) {
        return Result.err(
          new VisualDefinitionError({
            reason: "data",
            message: `Each row in data.${spec.dataset} must supply ${spec.x.field} and ${spec.y.field} with values matching the chart channels.`,
          }),
        );
      }
    }
    let referenced = fields.get(spec.dataset);
    if (!referenced) {
      referenced = new Set();
      fields.set(spec.dataset, referenced);
    }
    referenced.add(spec.x.field);
    referenced.add(spec.y.field);
  }
  const unused = unreferencedDataKey({
    data: input.data,
    html: normalized.value,
    fields,
  });
  if (unused !== null) {
    return Result.err(
      new VisualDefinitionError({
        reason: "data",
        message: `Remove unreferenced data key ${unused}, or reference it literally in the page or chart specification.`,
      }),
    );
  }
  return Result.ok({
    title: input.title,
    html: normalized.value,
    data: input.data,
    charts: input.charts,
  });
};
