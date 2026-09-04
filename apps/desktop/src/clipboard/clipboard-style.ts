import type { ClipboardGroupColor } from "./clipboard-types";

export const CLIPBOARD_GROUP_ACCENTS = {
  amber: "var(--color-amber-400)",
  blue: "var(--color-blue-400)",
  emerald: "var(--color-emerald-400)",
  gray: "var(--color-neutral-400)",
  rose: "var(--color-rose-400)",
  violet: "var(--color-violet-400)",
} as const satisfies Record<ClipboardGroupColor, string>;
