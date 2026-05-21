// TODO: Add `color` column to clients and workspaces.
// Clients get a user-assignable color; new workspaces
// inherit a shade from their client's color by default.
// Replace this deterministic hash with the stored color.
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
