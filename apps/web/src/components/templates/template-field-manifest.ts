import {
  isBusinessRegistrySlug,
  type BusinessRegistrySlug,
} from "@stll/api-contract";

export type LookupRegistry = BusinessRegistrySlug;

/** Narrows a manifest's raw lookup registry to a supported slug, so the Studio
 *  restores lookups for every offered registry — not just KRS — on reopen. */
export const isLookupRegistry = (value: unknown): value is LookupRegistry =>
  isBusinessRegistrySlug(value);

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
