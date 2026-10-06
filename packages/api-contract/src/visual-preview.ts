import * as v from "valibot";

export const VISUAL_PREVIEW_LIMITS = {
  documentBytes: 2 * 1024 * 1024,
  pngBase64Chars: 1.5 * 1024 * 1024,
  consoleErrors: 20,
  errorChars: 500,
  width: 1200,
  height: 2400,
  readyTimeoutMs: 3000,
  renderTimeoutMs: 10_000,
  invocationTimeoutMs: 18_000,
} as const;

export const visualPreviewInputSchema = v.strictObject({
  document: v.pipe(
    v.string(),
    v.maxLength(VISUAL_PREVIEW_LIMITS.documentBytes),
    v.check(
      (value) =>
        new TextEncoder().encode(value).byteLength <=
        VISUAL_PREVIEW_LIMITS.documentBytes,
    ),
  ),
  viewport: v.strictObject({ width: v.literal(VISUAL_PREVIEW_LIMITS.width) }),
});

export const visualPreviewOutputSchema = v.strictObject({
  png: v.pipe(
    v.string(),
    v.maxLength(VISUAL_PREVIEW_LIMITS.pngBase64Chars),
    v.regex(/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u),
    v.check((value) => value.length % 4 === 0),
  ),
  consoleErrors: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(VISUAL_PREVIEW_LIMITS.errorChars))),
    v.maxLength(VISUAL_PREVIEW_LIMITS.consoleErrors),
  ),
  blockedRequests: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  ),
  size: v.strictObject({
    width: v.literal(VISUAL_PREVIEW_LIMITS.width),
    height: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(VISUAL_PREVIEW_LIMITS.height),
    ),
  }),
  readyFired: v.boolean(),
});

export type VisualPreviewInput = v.InferOutput<typeof visualPreviewInputSchema>;
export type VisualPreviewOutput = v.InferOutput<
  typeof visualPreviewOutputSchema
>;
