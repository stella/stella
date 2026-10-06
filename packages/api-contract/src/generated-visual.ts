import * as v from "valibot";

import { VISUAL_SANDBOX_LIMITS } from "./visual-sandbox";

export const GENERATED_VISUAL_LIMITS = {
  dataBytes: 1024 * 1024,
  dataDepth: 32,
  dataNodes: 50_000,
  charts: 16,
  chartRows: 10_000,
} as const;

const fieldNameSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const quantitativeChannelSchema = v.strictObject({
  field: fieldNameSchema,
  type: v.literal("quantitative"),
  scale: v.picklist(["linear", "log"]),
  label: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const horizontalChannelSchema = v.variant("type", [
  quantitativeChannelSchema,
  v.strictObject({
    field: fieldNameSchema,
    type: v.literal("nominal"),
    scale: v.picklist(["band", "point"]),
    label: v.optional(v.pipe(v.string(), v.maxLength(200))),
  }),
  v.strictObject({
    field: fieldNameSchema,
    type: v.literal("temporal"),
    scale: v.literal("time"),
    label: v.optional(v.pipe(v.string(), v.maxLength(200))),
  }),
]);

export const visualChartSpecSchema = v.strictObject({
  mark: v.picklist(["bar", "line", "point", "area"]),
  dataset: fieldNameSchema,
  x: horizontalChannelSchema,
  y: quantitativeChannelSchema,
  height: v.pipe(v.number(), v.integer(), v.minValue(120), v.maxValue(800)),
});
export type VisualChartSpec = v.InferOutput<typeof visualChartSpecSchema>;

type VisualDataVisit = { value: unknown; depth: number };
const isBoundedVisualData = (data: Record<string, unknown>) => {
  const pending: VisualDataVisit[] = [{ value: data, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) {
      return false;
    }
    nodes += 1;
    if (
      nodes > GENERATED_VISUAL_LIMITS.dataNodes ||
      entry.depth > GENERATED_VISUAL_LIMITS.dataDepth
    ) {
      return false;
    }
    const { value, depth } = entry;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return false;
      }
      continue;
    }
    if (typeof value !== "object") {
      return false;
    }
    if (Array.isArray(value)) {
      if (pending.length + value.length > GENERATED_VISUAL_LIMITS.dataNodes) {
        return false;
      }
      for (const child of value) {
        pending.push({ value: child, depth: depth + 1 });
      }
      continue;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return false;
    }
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (
        !Object.hasOwn(descriptor, "value") ||
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        return false;
      }
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  return (
    new TextEncoder().encode(JSON.stringify(data)).byteLength <=
    GENERATED_VISUAL_LIMITS.dataBytes
  );
};

export const generatedVisualInputSchema = v.strictObject({
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(VISUAL_SANDBOX_LIMITS.titleChars),
  ),
  html: v.pipe(v.string(), v.maxLength(VISUAL_SANDBOX_LIMITS.htmlBytes)),
  data: v.pipe(
    v.record(fieldNameSchema, v.unknown()),
    v.check(
      isBoundedVisualData,
      "Use finite JSON values within the visual data size and nesting limits.",
    ),
  ),
  charts: v.pipe(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.regex(/^chart-[a-zA-Z0-9_-]{1,64}$/u)),
        spec: visualChartSpecSchema,
      }),
    ),
    v.maxLength(GENERATED_VISUAL_LIMITS.charts),
  ),
});
export type GeneratedVisualInput = v.InferOutput<
  typeof generatedVisualInputSchema
>;
