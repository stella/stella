import type { CSSProperties } from "react";

// Fallback swatches for older or imported workspaces without a stored color.
const DEFAULT_MATTER_SWATCH = "--option-blue";

export const MATTER_SWATCHES = [
  DEFAULT_MATTER_SWATCH,
  "--option-emerald",
  "--option-amber",
  "--option-violet",
  "--option-red",
  "--option-cyan",
  "--option-orange",
  "--option-teal",
] as const;

/** A stable, non-negative hash of a key, so one key always picks one swatch. */
const stableHash = (key: string) => {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash, 31) + (key.codePointAt(i) ?? 0);
  }
  return Math.abs(hash);
};

export const getMatterSwatch = (id: string) =>
  MATTER_SWATCHES[stableHash(id) % MATTER_SWATCHES.length] ??
  DEFAULT_MATTER_SWATCH;

export const getMatterColor = (id: string) => `var(${getMatterSwatch(id)})`;

/**
 * Swatches for time no matter claimed yet, such as one document's or window's
 * stretch of a day. A separate low-chroma set (`--topic-*` in theme.css), so
 * a topic is never painted in a colour a matter can have.
 */
const DEFAULT_TOPIC_SWATCH = "--topic-sand";

export const TOPIC_SWATCHES = [
  DEFAULT_TOPIC_SWATCH,
  "--topic-sage",
  "--topic-mist",
  "--topic-heather",
  "--topic-clay",
  "--topic-slate",
] as const;

export const getTopicSwatch = (key: string) =>
  TOPIC_SWATCHES[stableHash(key) % TOPIC_SWATCHES.length] ??
  DEFAULT_TOPIC_SWATCH;

export const getTopicColor = (key: string) => `var(${getTopicSwatch(key)})`;

const hexColorPattern = /^#?[0-9A-Fa-f]{6}$/u;

const toPickerColor = (color: string) => {
  if (color.startsWith("--option-")) {
    return color.slice("--option-".length);
  }

  if (color.startsWith("#")) {
    return color.slice(1).toUpperCase();
  }

  return color;
};

const resolveStoredMatterColor = (color: string) => {
  if (hexColorPattern.test(color)) {
    return color.startsWith("#") ? color : `#${color}`;
  }

  if (color.startsWith("--")) {
    return `var(${color})`;
  }

  return `var(--option-${color})`;
};

export const getMatterPickerColor = (id: string, color: string | null) =>
  toPickerColor(color ?? getMatterSwatch(id));

export const toStoredMatterColor = (color: string) => {
  if (hexColorPattern.test(color)) {
    return `#${color.replace("#", "").toUpperCase()}`;
  }

  if (color.startsWith("--option-")) {
    return color;
  }

  return `--option-${color}`;
};

/**
 * Resolves the swatch CSS variable for a matter, preferring the
 * explicit `color` token stored on the workspace record over the
 * deterministic id-hash fallback. One source of truth so trigger
 * pills, picker rows, and badges all paint the same matter the
 * same colour.
 */
export const resolveMatterColor = (id: string, color: string | null) =>
  color ? resolveStoredMatterColor(color) : getMatterColor(id);

/**
 * The ground a matter tint is mixed into: chrome rows or content. Root-resolved
 * tokens, so a subtree that re-points `--background` at the tint cannot feed
 * the tint back into itself.
 */
export const MATTER_TINT_GROUND = {
  chrome: "var(--untinted-sidebar)",
  content: "var(--untinted-background)",
} as const;

type MatterTintGround =
  (typeof MATTER_TINT_GROUND)[keyof typeof MATTER_TINT_GROUND];

/**
 * The matter tint a surface paints: 2% of the matter colour over its ground.
 * Every separately painted row (app header, inspector tab header, page
 * organizer toolbar) reads this one formula, so adjacent rows cannot drift.
 */
export const matterTint = (color: string | null, ground: MatterTintGround) =>
  color === null ? ground : `color-mix(in srgb, ${color} 2%, ${ground})`;

export type MatterChromeStyle = CSSProperties & {
  "--matter-background-tint": string;
  "--matter-sidebar-tint": string;
};

/** The tint variables a matter-scoped subtree paints its chrome and panes from. */
export const matterChromeStyle = (color: string | null): MatterChromeStyle => ({
  "--matter-background-tint": matterTint(color, MATTER_TINT_GROUND.content),
  "--matter-sidebar-tint": matterTint(color, MATTER_TINT_GROUND.chrome),
});
