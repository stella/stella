// Branded canonical identifiers keyed by `${country}-${scheme}`.
//
// Catches "right ID, wrong adapter" mismatches at compile time and is
// critical for multi-key registries (PL: KRS/NIP/REGON, CH: UID/CHID,
// NL: KvK/vestiging/RSIN, FR: SIREN/SIRET).

export type CanonicalId<Scheme extends string> = string & {
  readonly __brand: Scheme;
};

// Schemes for the registries on the build-order roadmap.
// Extend this tuple as new adapters land.
export const CANONICAL_ID_SCHEMES = [
  "CZ-ICO",
  "NO-ORGNR",
  "FI-Y",
  "PL-KRS",
  "PL-NIP",
  "PL-REGON",
  "GB-CRN",
  "FR-SIREN",
  "FR-SIRET",
  "BR-CNPJ",
] as const;

export type KnownCanonicalIdScheme = (typeof CANONICAL_ID_SCHEMES)[number];

// SAFETY: caller is responsible for validating the input matches scheme S
// (e.g. ARES has its own `validateIco` that runs before branding). The brand
// is a phantom type; this helper performs no runtime check, so narrowing
// `string` to `CanonicalId<S>` is the entire point of the helper.
export const unsafeBrand = <S extends string>(raw: string): CanonicalId<S> =>
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  raw as CanonicalId<S>;
