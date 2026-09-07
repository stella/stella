/**
 * Registries offered for one-click company autofill, shared by the template
 * fill form (the party-block "look up by company id" control) and the wizard's
 * "Company ID" field configurator. One list so the two surfaces can never
 * drift: a registry offered for configuration is always offered for autofill.
 *
 * The slug list is checked exhaustively against `BUSINESS_REGISTRY_SLUGS`;
 * labels are registry proper names (not translatable UI copy); `country` is the ISO
 * 3166-1 alpha-2 region (or a pseudo-region like "EU"), used to order options
 * jurisdiction-first.
 *
 * Autofill coverage per registry: the fill mapping (`extractRegistryFields` in
 * `registry-autofill.ts`) always fills the cross-registry baseline (name,
 * registration id, legal form, address) from the top-level hit, so every
 * registry here supports baseline autofill. Registry-specific identifiers
 * (tax/stat id, share capital) are only mapped for krs/ares/orsr today; the
 * others degrade to the baseline until their `details` branch is mapped.
 */

import type { LookupRegistry } from "@/components/templates/template-field-manifest";

export type LookupRegistryOption = {
  slug: LookupRegistry;
  label: string;
  name: string;
  country: string;
};

export const LOOKUP_REGISTRY_OPTIONS = [
  { slug: "ares", name: "ARES", label: "Czechia — ARES", country: "CZ" },
  { slug: "orsr", name: "ORSR", label: "Slovakia — ORSR", country: "SK" },
  { slug: "krs", name: "KRS", label: "Poland — KRS", country: "PL" },
  {
    slug: "companies-house",
    name: "Companies House",
    label: "United Kingdom — Companies House",
    country: "GB",
  },
  {
    slug: "denue",
    name: "INEGI DENUE",
    label: "Mexico — INEGI DENUE",
    country: "MX",
  },
  {
    slug: "brreg",
    name: "Brønnøysund (BRREG)",
    label: "Norway — Brønnøysund (BRREG)",
    country: "NO",
  },
  { slug: "prh", name: "PRH", label: "Finland — PRH", country: "FI" },
  {
    slug: "recherche-entreprises",
    name: "RNE",
    label: "France — RNE",
    country: "FR",
  },
  {
    slug: "edgar",
    name: "SEC EDGAR",
    label: "United States — SEC EDGAR",
    country: "US",
  },
  { slug: "gcis", name: "GCIS", label: "Taiwan — GCIS", country: "TW" },
  {
    slug: "vies",
    name: "VIES (VAT)",
    label: "European Union — VIES (VAT)",
    country: "EU",
  },
] as const satisfies readonly LookupRegistryOption[];

type MissingLookupRegistryOption = Exclude<
  LookupRegistry,
  (typeof LOOKUP_REGISTRY_OPTIONS)[number]["slug"]
>;

true satisfies MissingLookupRegistryOption extends never ? true : never;
