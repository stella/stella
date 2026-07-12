/** Registries the lookup affordance offers; mirrors the manifest's supported
 *  set (`LOOKUP_REGISTRIES` in apps/api/src/handlers/docx/types.ts, itself the
 *  full `BUSINESS_REGISTRY_SLUGS`). Eden exposes types only, so the slugs are
 *  mirrored here — extend together with the API. */
const LOOKUP_REGISTRIES = [
  "ares",
  "brreg",
  "companies-house",
  "edgar",
  "gcis",
  "krs",
  "orsr",
  "prh",
  "recherche-entreprises",
  "vies",
] as const;

export type LookupRegistry = (typeof LOOKUP_REGISTRIES)[number];

/** Narrows a manifest's raw lookup registry to a supported slug, so the Studio
 *  restores lookups for every offered registry — not just KRS — on reopen. */
export const isLookupRegistry = (value: unknown): value is LookupRegistry =>
  typeof value === "string" &&
  LOOKUP_REGISTRIES.some((registry) => registry === value);

export const INPUT_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "select",
] as const;

export type InputType = (typeof INPUT_TYPES)[number];

const INPUT_TYPE_SET: ReadonlySet<string> = new Set(INPUT_TYPES);

export const isInputType = (value: string): value is InputType =>
  INPUT_TYPE_SET.has(value);

/**
 * The manifest shape of a field's composite configuration: parts and format
 * are emitted together, or not at all (a half-configured composite — no parts
 * yet, or no format yet — saves as a plain field). Only the part `key`s are
 * read, so callers may pass any part-shaped list (e.g. `EditablePart[]`)
 * without this module depending on that type.
 */
export const defaultCompositeFormat = (
  parts: readonly { key: string }[],
): string | undefined => {
  const keys = parts.flatMap((p) => {
    const key = p.key.trim();
    return key === "" ? [] : [key];
  });
  if (keys.length === 0) {
    return undefined;
  }
  return keys.map((k) => `{{${k}}}`).join(" ");
};
