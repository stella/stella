// TODO: Add `color` column to clients and workspaces.
// Clients get a user-assignable color; new workspaces
// inherit a shade from their client's color by default.
// Replace this deterministic hash with the stored color.
export const MATTER_SWATCHES = [
  "--option-blue",
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
  return MATTER_SWATCHES[Math.abs(hash) % MATTER_SWATCHES.length];
};

export const getMatterColor = (id: string) => `var(${getMatterSwatch(id)})`;

/**
 * Resolves the swatch CSS variable for a matter, preferring the
 * explicit `color` token stored on the workspace record over the
 * deterministic id-hash fallback. One source of truth so trigger
 * pills, picker rows, and badges all paint the same matter the
 * same colour.
 */
export const resolveMatterColor = (id: string, color: string | null) =>
  color ? `var(${color})` : getMatterColor(id);
