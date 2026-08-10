import { BLUEPRINTS } from "./blueprints.gen";

export { BLUEPRINTS } from "./blueprints.gen";

export type Blueprint = (typeof BLUEPRINTS)[number];
export type BlueprintId = Blueprint["id"];

// The gallery order is product-facing, while the generated manifest is
// alphabetical. Keep the intentional order as a tuple for route-schema
// inference, and make missing generated IDs a compile error.
const BLUEPRINT_ID_VALUES = [
  "check-against-rules",
  "intake-to-draft",
  "answer-from-sources",
  "blank",
] as const satisfies readonly BlueprintId[];

type MissingBlueprintId = Exclude<
  BlueprintId,
  (typeof BLUEPRINT_ID_VALUES)[number]
>;

true satisfies MissingBlueprintId extends never ? true : never;

export const BLUEPRINT_IDS = BLUEPRINT_ID_VALUES;

export const getBlueprint = (id: string): Blueprint | undefined =>
  BLUEPRINTS.find((blueprint) => blueprint.id === id);
