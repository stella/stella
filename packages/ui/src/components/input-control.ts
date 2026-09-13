import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";

// `items-center` is load-bearing, not cosmetic: the control draws its leading
// search icon absolutely, centred on this box, while the field's text is
// centred on the field's own box. A caller height lands here, on the control,
// and leaves the field at its shared metrics, so without centring the two
// boxes disagree and the glyph sits off the text's line.
export const INPUT_CONTROL_CLASS_NAME =
  "border-input bg-background text-foreground ring-ring/24 has-autofill:bg-foreground/4 has-focus-visible:border-ring has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 relative inline-flex w-full items-center rounded-lg border text-base shadow-xs/5 transition-shadow not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] pointer-coarse:min-h-11";

// `pointer-coarse:self-stretch` rides with the coarse-pointer height: the
// centred control no longer stretches its field by default, and a touch target
// that stopped at the text's line would be shorter than the 44px the control
// reserves.
export const INPUT_ELEMENT_CLASS_NAME =
  "placeholder:text-foreground-placeholder h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:h-7.5 sm:leading-7.5 pointer-coarse:h-full pointer-coarse:self-stretch";

export const INPUT_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5 pointer-coarse:h-full",
  [CONTROL_SIZE.default]: undefined,
  [CONTROL_SIZE.lg]:
    "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5 pointer-coarse:h-full",
} as const satisfies Record<ControlSize, string | undefined>;
