// Three integration shapes every registry adapter falls into. Modelled as
// a discriminated union so the dispatch layer can branch at compile time
// instead of stringly-typed runtime checks.
//
// - rpc: live request/response (ARES, Brreg, Companies House, ...).
// - local-index: bulk-only sources ingested into Postgres nightly and
//   served via the same exported functions (BE-KBO, LU-RCSL, GLEIF, ...).
// - event-stream: state reconstructed from gazette events
//   (ES-BORME, PT-publicacoes).

export type RegistryAdapterShape =
  | { type: "rpc" }
  | { type: "local-index" }
  | { type: "event-stream" };

export type RegistryDescriptor<Scheme extends string> = {
  slug: string;
  country: string;
  idScheme: Scheme;
  shape: RegistryAdapterShape;
};
