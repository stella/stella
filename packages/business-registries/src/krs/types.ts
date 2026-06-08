// ---------------------------------------------------------------------------
// Raw KRS (Krajowy Rejestr Sądowy) `OdpisAktualny` response shapes
// (https://api-krs.ms.gov.pl/api/krs/ — REST endpoint, free, no auth).
//
// Only the fields we surface today are typed. The KRS payload is
// extensive (statutory bodies, share capital, mergers, court files,
// …); extend these declarations as we promote more fields into the
// domain output. Field names mirror the Polish JSON keys verbatim so
// the mapping from fixtures stays mechanical.
// ---------------------------------------------------------------------------

/**
 * `rejestr` discriminator: KRS is split into two sub-registers.
 *   - `RejP` (Rejestr Przedsiębiorców) — commercial entities; the
 *     default for company lookups.
 *   - `RejS` (Rejestr Stowarzyszeń) — associations, foundations,
 *     trade unions, public benefit organisations.
 *
 * The same KRS number can only exist in one register, so the lookup
 * client probes `P` first and falls back to `S` on 404.
 */
export type KrsRegisterCode = "RejP" | "RejS";

export type KrsRawIdentifiers = {
  regon?: string;
  nip?: string;
};

export type KrsRawDanePodmiotu = {
  formaPrawna?: string;
  identyfikatory?: KrsRawIdentifiers;
  nazwa?: string;
  daneOWczesniejszejRejestracji?: Record<string, unknown>;
  czyProwadziDzialalnoscZInnymiPodmiotami?: boolean;
  czyPosiadaStatusOPP?: boolean;
};

export type KrsRawSiedziba = {
  kraj?: string;
  wojewodztwo?: string;
  powiat?: string;
  gmina?: string;
  miejscowosc?: string;
};

export type KrsRawAdres = {
  ulica?: string;
  nrDomu?: string;
  nrLokalu?: string;
  miejscowosc?: string;
  kodPocztowy?: string;
  poczta?: string;
  kraj?: string;
};

export type KrsRawSiedzibaIAdres = {
  siedziba?: KrsRawSiedziba;
  adres?: KrsRawAdres;
  adresPocztyElektronicznej?: string;
  adresStronyInternetowej?: string;
  adresDoDoreczenElektronicznychWpisanyDoBAE?: string;
};

/**
 * `kapital` (dzial1) carries the entity's capital figures. We surface
 * only the share capital (kapitał zakładowy) today — present for both
 * sp. z o.o. and S.A. The remaining sub-fields (kapitał docelowy /
 * zapasowy, akcje, aporty, …) are typed lazily as we promote them.
 */
export type KrsRawMonetaryValue = {
  wartosc?: string;
  waluta?: string;
};

export type KrsRawKapital = {
  wysokoscKapitaluZakladowego?: KrsRawMonetaryValue;
};

export type KrsRawDzial1 = {
  danePodmiotu?: KrsRawDanePodmiotu;
  siedzibaIAdres?: KrsRawSiedzibaIAdres;
  kapital?: KrsRawKapital;
  // Further optional sub-objects (umowaStatut, emisjeAkcji, …) not
  // surfaced yet.
};

// Each entry in the combined restructuring/liquidation dzial6 array
// nests its `rodzajPostepowania` (proceeding kind) under the opening
// sub-object (the closing sub-object would carry it too, but only on
// proceedings that have ended). The opening sub-object name is the
// full noun phrase — the upstream schema does not abbreviate.
//
// Observed `rodzajPostepowania` values in the wild:
//   "PRZYMUSOWA RESTRUKTURYZACJA"           → compulsory restructuring
//   "POSTĘPOWANIE NAPRAWCZE"                → repair proceedings
//   "POSTĘPOWANIE RESTRUKTURYZACYJNE"       → restructuring
//   "POSTĘPOWANIE UKŁADOWE"                 → arrangement (a restructuring variant)
//   "UPORZĄDKOWANA LIKWIDACJA"              → orderly liquidation
//   "LIKWIDACJA" / "POSTĘPOWANIE LIKWIDACYJNE"  → liquidation
// Only values containing the Polish stem `LIKWIDAC` map to the
// `liquidating` status; everything else is restructuring.
export type KrsRawProceedingDetail = {
  rodzajPostepowania?: string;
  organWydajacy?: string;
  sygnatura?: string;
};

export type KrsRawProceeding = {
  otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji?: KrsRawProceedingDetail;
  zakonczeniePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji?: KrsRawProceedingDetail;
};

// Dzial 6 carries the lifecycle events we map onto the status union.
// Each sub-array is present only when the corresponding event has
// been recorded against the entity.
export type KrsRawDzial6 = {
  // Mergers / splits / transformations — not used for status; just
  // typed for forward compatibility.
  polaczeniePodzialPrzeksztalcenie?: unknown[];
  // Bankruptcy proceedings (upadłość). Present arrays here flip the
  // status to `bankruptcy`.
  postepowanieUpadlosciowe?: unknown[];
  // Restructuring / repair / compulsory restructuring / orderly
  // liquidation — single combined array in the upstream schema, but
  // semantically distinct. The parser inspects each entry's
  // `rodzajPostepowania` to decide between `restructuring` and
  // `liquidating`; mislabelling a live restructuring as liquidation
  // would materially misstate the entity's lifecycle.
  postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja?: KrsRawProceeding[];
  // Removal from the register (wykreślenie) — flips to `dissolved`.
  // The `OdpisAktualny` endpoint in practice does not return removed
  // entities at all (it 404s), so this is defensive — present here
  // for the rare case where the upstream still surfaces a removed
  // record on the active endpoint.
  wykreslenia?: unknown[];
};

export type KrsRawDane = {
  dzial1?: KrsRawDzial1;
  dzial2?: Record<string, unknown>;
  dzial3?: Record<string, unknown>;
  dzial4?: Record<string, unknown>;
  dzial5?: Record<string, unknown>;
  dzial6?: KrsRawDzial6;
};

export type KrsRawNaglowekA = {
  rejestr?: string;
  numerKRS?: string;
  dataCzasOdpisu?: string;
  stanZDnia?: string;
  dataRejestracjiWKRS?: string;
  numerOstatniegoWpisu?: number;
  dataOstatniegoWpisu?: string;
  sygnaturaAktSprawyDotyczacejOstatniegoWpisu?: string;
  oznaczenieSaduDokonujacegoOstatniegoWpisu?: string;
  // `stanPozycji` ≥ 1 indicates the entity has at least one filed
  // entry; the API only returns records with a valid position via
  // `OdpisAktualny`.
  stanPozycji?: number;
};

export type KrsRawOdpis = {
  // `Aktualny` (current) on this endpoint; `Pelny` (full) on the
  // sibling endpoint we do not call.
  rodzaj?: string;
  naglowekA?: KrsRawNaglowekA;
  dane?: KrsRawDane;
};

export type KrsLookupResponse = {
  odpis?: KrsRawOdpis;
};

// KRS surfaces RFC 7807-style problem details on 404; we type the
// minimum we read for error messages.
export type KrsErrorResponse = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  traceId?: string;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type KrsAddress = {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  textAddress: string | null;
};

export type KrsIdentifiers = {
  /** NIP (tax ID) — 10 digits, optional in the upstream payload. */
  nip: string | null;
  /** REGON (statistical ID) — 9 or 14 digits. */
  regon: string | null;
};

// Status discriminated union — mapped from `dzial6` event arrays plus
// the entity name's "W UPADŁOŚCI" / "W LIKWIDACJI" suffix (KRS still
// suffixes the formal name even after the dzial6 entry is filed, so
// the suffix acts as a redundant confirmation rather than the sole
// signal). The `unknown` arm covers entities whose dzial6 is empty
// AND whose name carries no marker — i.e. ordinary live companies.
//
// `active` is the typical case for an `OdpisAktualny` hit: the API
// does not return removed entities on this endpoint, so the absence
// of any lifecycle event marker means the entity is operating
// normally.
export type KrsEntityStatus =
  | { type: "active" }
  | { type: "bankruptcy" }
  // A live restructuring proceeding (postępowanie restrukturyzacyjne /
  // naprawcze / przymusowa restrukturyzacja) — the company is being
  // re-organised but is NOT in liquidation. KRS lumps these together
  // with orderly liquidation in one combined dzial6 array, so the
  // parser inspects each entry's `rodzajPostepowania` to tell them
  // apart.
  | { type: "restructuring" }
  | { type: "liquidating" }
  | { type: "dissolved" }
  | { type: "unknown" };

export type KrsEntity = {
  /** Canonical 10-digit KRS number. */
  krsNumber: string;
  register: KrsRegisterCode;
  name: string;
  legalForm: string | null;
  identifiers: KrsIdentifiers;
  /**
   * Share capital (kapitał zakładowy) as filed: `amount` is the raw KRS
   * decimal string (Polish comma decimal, e.g. "99910510,00") and
   * `currency` the ISO code (e.g. "PLN"). Present for sp. z o.o. and
   * S.A.; `null` for entities the register files without a capital
   * figure (e.g. RejS associations) or incomplete records. Surfaced
   * verbatim — the caller converts to a branded minor-unit amount at
   * the app boundary, mirroring how KRS dates are left unparsed here.
   */
  shareCapital: { amount: string; currency: string } | null;
  address: KrsAddress | null;
  /**
   * Registered seat (siedziba) — administrative coordinates
   * (voivodeship, powiat, gmina, miejscowość) the registrar files
   * separately from the postal address. Surfaced verbatim because
   * the seat answers questions the postal address cannot (court
   * jurisdiction, statistical aggregation).
   */
  registeredSeat: KrsRegisteredSeat | null;
  email: string | null;
  website: string | null;
  status: KrsEntityStatus;
  /** First entry filed against the entity (registration date). */
  registeredAt: string | null;
  /** Last entry filed against the entity. */
  lastEntryAt: string | null;
  /** Stable public KRS API URL for the current-register JSON extract. */
  registryUrl: string;
};

export type KrsRegisteredSeat = {
  country: string | null;
  voivodeship: string | null;
  county: string | null;
  commune: string | null;
  locality: string | null;
};
