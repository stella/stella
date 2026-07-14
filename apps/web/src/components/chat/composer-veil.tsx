import { cn } from "@stll/ui/lib/utils";

/**
 * The one glass veil rendered behind a chat composer stack (input +
 * status row) wherever the composer floats over live content — the
 * main-chat tray over the transcript, and every `DockedComposer`
 * surface (inspector chat tab, file/PDF overlay, Template Studio)
 * over documents. Single owner of the treatment so surfaces cannot
 * drift: heavy blur, low `bg-background` tint (the opaque token;
 * muted/secondary are translucent), a stronger tint fallback when
 * `backdrop-filter` is unsupported (the tint alone must then carry
 * the contrast), and a feathered top edge (mask fades the first
 * 2rem) so it reads as a soft veil, never a hard-edged bar.
 *
 * Contract: render it as the first child of a `relative` parent that
 * creates a stacking context (`isolate` or an explicit z-index) — the
 * veil absolutely fills that parent at `-z-10`, behind its siblings.
 * `rounded` is the compact tray treatment used by the main chat. `pane`
 * feathers across the full host width for document overlays, avoiding a
 * visible rounded blur band while keeping text beneath the controls quiet.
 */
export const ComposerVeil = ({
  className,
  variant = "rounded",
}: {
  className?: string | undefined;
  variant?: "pane" | "rounded";
}) => (
  <div
    aria-hidden="true"
    className={cn(
      "pointer-events-none absolute -z-10",
      variant === "rounded" &&
        "bg-background/75 supports-[backdrop-filter]:bg-background/40 inset-0 rounded-3xl [mask-image:linear-gradient(to_bottom,transparent,black_2rem)] backdrop-blur-xl",
      variant === "pane" &&
        "via-background/65 to-background/95 supports-[backdrop-filter]:via-background/50 supports-[backdrop-filter]:to-background/85 inset-x-0 -top-5 -bottom-3.5 bg-linear-to-b from-transparent [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)] backdrop-blur-sm",
      className,
    )}
  />
);
