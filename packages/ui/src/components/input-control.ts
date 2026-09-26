import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";

/**
 * A text control is two boxes: the bordered wrapper a caller styles and the
 * element the text is typed into. The wrapper is what a height applies to and
 * what the search icon centres on, so the element never states a height of its
 * own — it fills whatever the wrapper turns out to be. A size only sets the
 * floor (`min-h-*`, always the element's own line box), which is what gives an
 * unsized control its height. Give the element a fixed height again and the
 * two boxes drift apart the moment a caller sizes the wrapper: the text sits
 * at the top of the control while the icon stays centred.
 */
export const INPUT_CONTROL_CLASS_NAME =
  "border-input bg-background text-foreground ring-ring/24 has-autofill:bg-foreground/4 has-focus-visible:border-ring has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 relative inline-flex w-full rounded-lg border text-base shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] pointer-coarse:min-h-11";

export const INPUT_ELEMENT_CLASS_NAME =
  "placeholder:text-foreground-placeholder h-full min-h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:min-h-7.5 sm:leading-7.5";

export const INPUT_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "min-h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:min-h-6.5 sm:leading-6.5",
  [CONTROL_SIZE.default]: undefined,
  [CONTROL_SIZE.lg]: "min-h-9.5 leading-9.5 sm:min-h-8.5 sm:leading-8.5",
} as const satisfies Record<ControlSize, string | undefined>;
