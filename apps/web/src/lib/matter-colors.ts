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

export const getMatterSwatch = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash, 31) + (id.codePointAt(i) ?? 0);
  }
  return (
    MATTER_SWATCHES[Math.abs(hash) % MATTER_SWATCHES.length] ??
    DEFAULT_MATTER_SWATCH
  );
};

export const getMatterColor = (id: string) => `var(${getMatterSwatch(id)})`;

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

/** The ground a matter tint is mixed into: chrome rows or content. */
export const MATTER_TINT_GROUND = {
  chrome: "var(--sidebar)",
  content: "var(--background)",
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
