import * as v from "valibot";

export const VISUAL_SANDBOX_PATH = "/visual-sandbox";

export const VISUAL_SANDBOX_LIMITS = {
  htmlBytes: 256 * 1024,
  titleChars: 200,
  urlChars: 2048,
  depth: 64,
  nodes: 10_000,
  height: 10_000,
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

export const visualRenderMessageSchema = v.strictObject({
  type: v.literal("render"),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(VISUAL_SANDBOX_LIMITS.titleChars),
  ),
  html: v.pipe(v.string(), v.maxLength(VISUAL_SANDBOX_LIMITS.htmlBytes)),
});

export const visualGuestMessageSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("resize"),
    height: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(VISUAL_SANDBOX_LIMITS.height),
    ),
  }),
  v.strictObject({ type: v.literal("open-link"), url: visualLinkSchema }),
]);
