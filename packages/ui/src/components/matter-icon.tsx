import { LayersIcon } from "../icons";
import { resolveMatterColor } from "../lib/matter-colors";
import { cn } from "../lib/utils";
import {
  ALL_MATTERS_STACK,
  type MatterIconContract,
} from "./matter-icon.shared";

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
// raw `LayersIcon` import everywhere except this file (and the shared icon
// module that re-exports it). Callers keep full
// control of size/spacing via `className`; this component only owns the
// glyph and its colour.

type MatterIconProps = { className?: string | undefined } & MatterIconContract;

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

  // "All matters": three stacked planes in fixed palette tints (not
  // currentColor), so the affordance reads as "the whole set" rather than any
  // one matter, wherever it appears (picker rows, section headers).
  if (props.variant === "all") {
    return (
      <svg
        aria-hidden="true"
        className={cn(props.className)}
        fill="none"
        viewBox="0 0 24 24"
      >
        {ALL_MATTERS_STACK.map(({ d, option }) => (
          <path
            d={d}
            key={option}
            stroke={`var(--option-${option})`}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        ))}
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
// it as `<Icon className={...} />`. Paints the muted mono glyph so the
// matters entry reads like its neighbouring nav icons (search, chat,
// contacts) rather than singling itself out with the tri-plane colour;
// a specific matter still gets its colour wherever one is actually named.
export const MattersNavIcon = ({
  className,
}: {
  className?: string | undefined;
}) => <MatterIcon className={className} variant="none" />;
