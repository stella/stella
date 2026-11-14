import { LayersIcon } from "lucide-react-native";
import Svg, { Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";

import { resolveMatterColor } from "../lib/matter-colors";
import {
  ALL_MATTERS_STACK,
  type MatterIconContract,
} from "./matter-icon.shared";

/**
 * Every palette option a matter can be painted in, as a class. uniwind keeps
 * only the theme variables some class uses, so naming each option here keeps
 * its colour resolvable from a matter's stored `var(--option-<name>)`.
 */
const MATTER_OPTION_CLASS_NAMES = {
  amber: "accent-option-amber",
  blue: "accent-option-blue",
  cyan: "accent-option-cyan",
  emerald: "accent-option-emerald",
  fuchsia: "accent-option-fuchsia",
  gray: "accent-option-gray",
  green: "accent-option-green",
  indigo: "accent-option-indigo",
  lime: "accent-option-lime",
  orange: "accent-option-orange",
  purple: "accent-option-purple",
  red: "accent-option-red",
  sky: "accent-option-sky",
  teal: "accent-option-teal",
  violet: "accent-option-violet",
  yellow: "accent-option-yellow",
} as const;

const MUTED = "--color-muted-foreground";

/**
 * The theme variable a CSS colour from `resolveMatterColor` names
 * (`var(--option-blue)` is `--color-option-blue`), or null for a literal
 * colour such as a stored hex.
 */
const themeVariable = (css: string): string | null => {
  const option = /^var\(--option-([a-z]+)\)$/u.exec(css)?.[1];
  if (option === undefined) {
    return css.startsWith("var(") ? MUTED : null;
  }
  return option in MATTER_OPTION_CLASS_NAMES
    ? `--color-option-${option}`
    : MUTED;
};

/**
 * A theme variable's value as a colour. `currentColor` stands in only while
 * the theme has not resolved the variable, which a class in this file keeps
 * from happening.
 */
const asColour = (value: string | number | undefined): string =>
  typeof value === "string" ? value : "currentColor";

/**
 * The shared contract, with a matter's colour optional: the app's matter
 * records leave it out when none is stored, which the web reads as null.
 */
type MatterIconProps = (
  | { matter: { id: string; color?: string | null | undefined } }
  | Exclude<MatterIconContract, { matter: unknown }>
) & { size?: number | undefined };

/**
 * The web's `MatterIcon` (./matter-icon.tsx) on a phone: lucide's layers in
 * the matter's own colour, resolved by the web's `resolveMatterColor` (the
 * stored colour, else a swatch hashed from the id); the muted glyph for no
 * matter; the tri-plane stack for all of them.
 */
export const MatterIcon = (props: MatterIconProps) => {
  const size = props.size ?? 16;
  const css =
    "matter" in props
      ? resolveMatterColor(props.matter.id, props.matter.color ?? null)
      : null;
  const variable = css === null ? MUTED : themeVariable(css);
  const [resolved, ...stack] = useCSSVariable([
    variable ?? MUTED,
    ...ALL_MATTERS_STACK.map(({ option }) => `--color-option-${option}`),
  ]);
  if ("variant" in props && props.variant === "all") {
    return (
      <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
        {ALL_MATTERS_STACK.map(({ d, option }, index) => (
          <Path
            d={d}
            key={option}
            stroke={asColour(stack[index])}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        ))}
      </Svg>
    );
  }
  return (
    <LayersIcon
      color={variable === null && css !== null ? css : asColour(resolved)}
      size={size}
    />
  );
};
