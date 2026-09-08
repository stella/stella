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
