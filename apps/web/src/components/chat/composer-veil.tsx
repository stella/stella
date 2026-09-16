import { cn } from "@stll/ui/utils";

const PANE_MASK_IMAGE =
  "linear-gradient(to right, transparent, black clamp(0.75rem, calc((100% - 35rem) / 2), 12.5rem), black calc(100% - clamp(0.75rem, calc((100% - 35rem) / 2), 12.5rem)), transparent), linear-gradient(to bottom, transparent, black 1.25rem)";

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
 * visible rounded blur band while keeping text beneath the controls quiet. Its
 * mask feathers across its top and sides; it stays covered through the host's
 * bottom edge so the page does not return to sharp focus below the controls.
 * The top overhang (`-top-5`) and the mask's vertical feather (1.25rem) are one
 * value: the veil reaches full strength exactly at the composer's top edge, so
 * the haze over live document text is a 20px transition band and never a
 * multi-line block of softened text above the bar. Raising one without the
 * other either hides readable lines or leaves a hard edge.
 * The tint is deliberately light when backdrop-filter works: blur quiets page
 * text without painting a conspicuous patch over an otherwise empty canvas.
 */
export const ComposerVeil = ({
  className,
  variant: variantProp,
}: {
  className?: string | undefined;
  variant?: "pane" | "rounded";
}) => {
  const variant = variantProp ?? "rounded";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -z-10",
        variant === "rounded" &&
          "bg-background/75 supports-[backdrop-filter]:bg-background/40 inset-0 rounded-3xl [mask-image:linear-gradient(to_bottom,transparent,black_2rem)] backdrop-blur-xl",
        variant === "pane" &&
          "via-background/45 to-background/75 supports-[backdrop-filter]:via-background/15 supports-[backdrop-filter]:to-background/30 inset-x-0 -top-5 -bottom-3.5 bg-linear-to-b from-transparent [mask-composite:intersect] backdrop-blur-md backdrop-saturate-50",
        className,
      )}
      style={
        variant === "pane"
          ? {
              maskImage: PANE_MASK_IMAGE,
              WebkitMaskImage: PANE_MASK_IMAGE,
            }
          : undefined
      }
    />
  );
};
