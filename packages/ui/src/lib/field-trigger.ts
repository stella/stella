/**
 * The bordered box of a button that opens a picker inside a form (a select
 * trigger, a date field). One string so every popup-backed field shares the
 * input metric, focus ring, invalid and disabled treatment, and the 44px
 * coarse-pointer hit area.
 */
export const FIELD_TRIGGER_CLASS_NAME =
  "border-input bg-background text-foreground ring-ring/24 focus-visible:border-ring aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 dark:bg-input/32 dark:aria-invalid:ring-destructive/24 relative inline-flex min-h-9 w-full min-w-36 items-center justify-center gap-2 rounded-lg border px-[calc(--spacing(3)-1px)] text-start text-base shadow-xs/5 outline-none select-none not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-[3px] data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-8 sm:text-sm dark:not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [[data-disabled],:focus-visible,[aria-invalid],[data-pressed]]:shadow-none";
