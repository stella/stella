import * as v from "valibot";

export const VISUAL_THEME_SCRIPT_ID = "stella-visual-theme-data";

export const VISUAL_THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--border",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--destructive",
  "--ring",
  "--radius",
  "--font-sans",
  "--font-mono",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
] as const;

const visualThemeValueSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.check((value) => !/[;{}<>\\@]|url\s*\(|expression|\/\*|\*\//iu.test(value)),
);

// Both shell and guest validate this host-only stylesheet input. A finite key
// vocabulary and delimiter refusal prevent declarations from escaping :root.
export const visualThemeSchema = v.strictObject({
  appearance: v.picklist(["light", "dark"]),
  variables: v.record(
    v.picklist(VISUAL_THEME_VARIABLES),
    visualThemeValueSchema,
  ),
});

export type VisualTheme = v.InferOutput<typeof visualThemeSchema>;

export const visualThemeMessageSchema = v.strictObject({
  kind: v.literal("theme"),
  theme: visualThemeSchema,
});
