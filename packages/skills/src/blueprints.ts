import { BLUEPRINTS } from "./blueprints.gen";

export { BLUEPRINTS } from "./blueprints.gen";

// The ordered set of skill "ways" the gallery offers. Kept as an explicit
// literal tuple (not derived from BLUEPRINTS) so it stays a typed union for
// route schemas and so the gallery's display order is intentional rather than
// alphabetical.
export const BLUEPRINT_IDS = [
  "check-against-rules",
  "intake-to-draft",
  "answer-from-sources",
  "blank",
] as const;

export type BlueprintId = (typeof BLUEPRINT_IDS)[number];

export type Blueprint = (typeof BLUEPRINTS)[number];

export const getBlueprint = (id: string): Blueprint | undefined =>
  BLUEPRINTS.find((blueprint) => blueprint.id === id);
