import { LayersIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

import { resolveMatterColor } from "@/lib/matter-colors";

// The one and only place allowed to render the matter (layers) glyph.
//
// A specific matter is UNREPRESENTABLE without its colour: the `matter`
// arm always resolves a colour through `resolveMatterColor`, which is
// total (it falls back to a deterministic id-hash swatch when no colour
// is stored). The non-matter affordances are explicit, discriminated
// variants for pickers, empty states, and the matters nav entry:
// `variant="none"` paints a muted mono glyph; `variant="all"` paints the
// tri-plane "all matters" stack. No prop combination yields a specific
// matter with a default/mono colour.
//
// Enforced by `.oxlint-plugins/no-direct-matter-glyph.ts`, which bans the
// raw `LayersIcon` import everywhere except this file. Callers keep full
// control of size/spacing via `className`; this component only owns the
// glyph and its colour.

// The three stacked-plane tints for the "all matters" glyph. Fixed
// palette option colours (not currentColor) so the stack reads as "many
// matters at once" wherever it appears (picker rows, section headers).
const ALL_MATTERS_STACK_COLORS = [
  "var(--option-red)",
  "var(--option-blue)",
  "var(--option-green)",
] as const;

type MatterIconProps = { className?: string | undefined } & (
  | { matter: { id: string; color: string | null } }
  | { variant: "none" | "all" }
);

export const MatterIcon = (props: MatterIconProps) => {
  if ("matter" in props) {
    return (
      <LayersIcon
        aria-hidden="true"
        className={cn(props.className)}
        style={{
          color: resolveMatterColor(props.matter.id, props.matter.color),
        }}
      />
    );
  }

  // "All matters": three stacked planes in fixed palette tints, so the
  // affordance reads as "the whole set" rather than any one matter.
  if (props.variant === "all") {
    return (
      <svg
        aria-hidden="true"
        className={cn(props.className)}
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"
          stroke={ALL_MATTERS_STACK_COLORS[0]}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
        <path
          d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"
          stroke={ALL_MATTERS_STACK_COLORS[1]}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
        <path
          d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"
          stroke={ALL_MATTERS_STACK_COLORS[2]}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    );
  }

  // "No matter" affordance. Deliberately paints no matter colour: the
  // glyph inherits currentColor so it composes with its surroundings
  // (muted picker rows, section headers). Callers add
  // `text-muted-foreground` via className where a muted look is wanted.
  return <LayersIcon aria-hidden="true" className={cn(props.className)} />;
};

// Stable component reference for config-driven renderers (the primary nav,
// the onboarding sidebar preview) that store an icon component and render
// it as `<Icon className={...} />`. Represents the "all matters"
// navigation affordance (the tri-plane stack).
export const MattersNavIcon = ({
  className,
}: {
  className?: string | undefined;
}) => <MatterIcon className={className} variant="all" />;
