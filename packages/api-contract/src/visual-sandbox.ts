import * as v from "valibot";

export const VISUAL_GUEST_MARKER_ATTRIBUTE = "data-stella-visual-guest";

export const VISUAL_SANDBOX_PATH = "/visual-sandbox";

export const VISUAL_SANDBOX_LIMITS = {
  htmlBytes: 256 * 1024,
  titleChars: 200,
  urlChars: 2048,
  depth: 64,
  nodes: 10_000,
  height: 10_000,
  linkIdChars: 128,
} as const;

export const visualLinkSchema = v.pipe(
  v.string(),
  v.maxLength(VISUAL_SANDBOX_LIMITS.urlChars),
  v.url(),
  v.check((value) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  }),
);

const visualSizeSchema = v.strictObject({
  width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)),
  height: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(VISUAL_SANDBOX_LIMITS.height),
  ),
});

export const visualGuestMessageSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("resize"),
    height: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(VISUAL_SANDBOX_LIMITS.height),
    ),
  }),
  v.strictObject({ kind: v.literal("ready"), size: visualSizeSchema }),
  v.strictObject({ kind: v.literal("open-link"), url: visualLinkSchema }),
  v.strictObject({
    kind: v.literal("open-internal"),
    linkId: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(VISUAL_SANDBOX_LIMITS.linkIdChars),
    ),
  }),
  v.strictObject({
    kind: v.literal("drill"),
    court: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    year: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9999)),
  }),
]);
export type VisualGuestMessage = v.InferOutput<typeof visualGuestMessageSchema>;
