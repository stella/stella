/**
 * The web's button variants (packages/ui button.tsx), by the tokens each one
 * paints with; `ui-variants.test.ts` keeps the names in step with the web.
 */
export const BUTTON_VARIANTS = {
  default: {
    box: "border-primary bg-primary",
    label: "text-primary-foreground",
  },
  destructive: {
    box: "border-destructive/32 bg-destructive/10",
    label: "text-destructive-foreground",
  },
  "destructive-ghost": { box: "border-transparent", label: "text-destructive" },
  "destructive-outline": {
    box: "border-input bg-popover",
    label: "text-destructive-foreground",
  },
  ghost: { box: "border-transparent", label: "text-foreground" },
  link: { box: "border-transparent", label: "text-foreground underline" },
  muted: { box: "border-transparent", label: "text-muted-foreground" },
  outline: { box: "border-input bg-popover", label: "text-foreground" },
  secondary: {
    box: "border-transparent bg-secondary",
    label: "text-secondary-foreground",
  },
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
