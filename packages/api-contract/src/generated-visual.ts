import * as v from "valibot";

import { safeIdSchema } from "./safe-id";
import { visualLinkSchema, VISUAL_SANDBOX_LIMITS } from "./visual-sandbox";

export const GENERATED_VISUAL_LIMITS = {
  dataBytes: 1024 * 1024,
  dataDepth: 32,
  dataNodes: 50_000,
  titleChars: 120,
  links: 400,
  documentBytes: 2 * 1024 * 1024,
} as const;

type VisualDataVisit = { value: unknown; depth: number };
const isBoundedVisualData = (data: unknown) => {
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
    v.minLength(1),
    v.maxLength(GENERATED_VISUAL_LIMITS.titleChars),
  ),
  html: v.pipe(v.string(), v.maxLength(VISUAL_SANDBOX_LIMITS.htmlBytes)),
  data: v.pipe(
    v.unknown(),
    v.check(
      isBoundedVisualData,
      "Use finite JSON values within the visual data size and nesting limits.",
    ),
  ),
  links: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          id: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(VISUAL_SANDBOX_LIMITS.linkIdChars),
          ),
          decisionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        }),
      ),
      v.maxLength(GENERATED_VISUAL_LIMITS.links),
    ),
  ),
});
export const generatedVisualPageSchema = v.strictObject({
  ...generatedVisualInputSchema.entries,
  links: v.nonOptional(generatedVisualInputSchema.entries.links),
  literalLinks: v.array(visualLinkSchema),
});
export type GeneratedVisualPage = v.InferOutput<
  typeof generatedVisualPageSchema
>;

export type GeneratedVisualInput = v.InferOutput<
  typeof generatedVisualInputSchema
>;

export const VISUAL_DATA_SCRIPT_ID = "stella-visual-data";
export const visualRenderMessageSchema = v.strictObject({
  type: v.literal("render"),
  ...generatedVisualInputSchema.entries,
});

export const SHOW_VISUAL_TOOL_NAME = "show_visual";
export const GENERATED_VISUAL_MIME_TYPE = "application/vnd.stella.visual+json";
export const GENERATED_VISUAL_URI_PREFIX = "ui://stella/visual/";

export const generatedVisualResourceSchema = v.strictObject({
  uri: v.pipe(
    v.string(),
    v.startsWith(GENERATED_VISUAL_URI_PREFIX),
    v.check((uri) =>
      v.is(safeIdSchema, uri.slice(GENERATED_VISUAL_URI_PREFIX.length)),
    ),
  ),
  mimeType: v.literal(GENERATED_VISUAL_MIME_TYPE),
  text: generatedVisualInputSchema.entries.title,
});

export const generatedVisualPartSchema = v.strictObject({
  type: v.literal("ui-resource"),
  resource: generatedVisualResourceSchema,
  toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  toolName: v.literal(SHOW_VISUAL_TOOL_NAME),
});
