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
 * Pass `className` only for geometry (inset overrides when the veil
 * should overhang the stack); the glass values live here alone.
 */
export const ComposerVeil = ({
  className,
}: {
  className?: string | undefined;
}) => (
  <div
    aria-hidden="true"
    className={cn(
      "bg-background/75 supports-[backdrop-filter]:bg-background/40 pointer-events-none absolute inset-0 -z-10 rounded-3xl [mask-image:linear-gradient(to_bottom,transparent,black_2rem)] backdrop-blur-xl",
      className,
    )}
  />
);
