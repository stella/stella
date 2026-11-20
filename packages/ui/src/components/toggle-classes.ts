// The checkbox's and the switch's boxes, with no React or Base UI: the
// controls (./checkbox.tsx, ./switch.tsx) render them, and a loading view
// draws their faces (./control-face.tsx) from the same classes, so the face
// in a pending view and the control that replaces it share one box.

/** The checkbox's box: its size, border, focus ring and states. */
export const CHECKBOX_CLASS_NAME =
  "border-input bg-background ring-ring focus-visible:ring-offset-background aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/48 dark:not-data-checked:bg-input/32 dark:aria-invalid:ring-destructive/24 relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm border shadow-xs/5 outline-none not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-sm)-1px)] not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-2 focus-visible:ring-offset-1 data-disabled:opacity-64 sm:size-4 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none";

/**
 * `default` is a setting's own control; `sm` sits in a dense row or a menu
 * beside small type.
 */
export type SwitchSize = "sm" | "default";

/** The switch's track: its shape, colours and focus ring. */
export const SWITCH_ROOT_CLASS_NAME =
  "focus-visible:ring-ring focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input relative inline-flex shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-1 data-disabled:opacity-64";

export const SWITCH_ROOT_SIZE_CLASS_NAME = {
  default: "h-5 w-9",
  sm: "h-4 w-7",
} as const satisfies Record<SwitchSize, string>;
