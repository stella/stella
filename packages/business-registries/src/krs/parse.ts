import type {
  KrsAddress,
  KrsEntity,
  KrsEntityStatus,
  KrsIdentifiers,
  KrsLookupResponse,
  KrsRawAdres,
  KrsRawDzial6,
  KrsRawOdpis,
  KrsRawSiedziba,
  KrsRegisterCode,
  KrsRegisteredSeat,
} from "./types.js";

// KRS' public HTML viewer currently requires an opaque token that the
// open-data API does not return. The documented JSON lookup URL is
// therefore the only stable URL constructible from a KRS number.
const KRS_API_BASE = "https://api-krs.ms.gov.pl/api/krs";

// KRS suffixes the formal name with "W UPADŁOŚCI" (in bankruptcy)
// or "W LIKWIDACJI" (in liquidation) for the duration of the
// proceedings. The suffixes are case-sensitive Polish strings; we
// match case-insensitively to be robust against future styling
// changes in the upstream payload.
const BANKRUPTCY_NAME_PATTERN = /\bW UPADŁOŚCI\b/iu;
const LIQUIDATION_NAME_PATTERN = /\bW LIKWIDACJI\b/iu;

const REGISTER_CODES: ReadonlySet<KrsRegisterCode> = new Set(["RejP", "RejS"]);

const isKrsRegisterCode = (
  value: string | undefined,
): value is KrsRegisterCode =>
  value !== undefined && (REGISTER_CODES as ReadonlySet<string>).has(value);

const trimToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed || null;
};

const hasEntries = (value: unknown[] | undefined): boolean =>
  Array.isArray(value) && value.length > 0;

// Matches the Polish stem `LIKWIDAC` (case- and diacritic-insensitive
// via toUpperCase + RegExp; values come uppercased from KRS) so both
// `LIKWIDACJA`, `POSTĘPOWANIE LIKWIDACYJNE`, and `UPORZĄDKOWANA
// LIKWIDACJA` resolve to liquidation. Anything without this stem
// (restructuring, repair, compulsory restructuring, arrangement) is
// restructuring.
const LIQUIDATION_PROCEEDING_PATTERN = /LIKWIDAC/u;

const parseNameSuffixStatus = (name: string): KrsEntityStatus | null => {
  if (BANKRUPTCY_NAME_PATTERN.test(name)) {
    return { type: "bankruptcy" };
  }
  if (LIQUIDATION_NAME_PATTERN.test(name)) {
    return { type: "liquidating" };
  }
  return null;
};

export const parseStatus = (
  dzial6: KrsRawDzial6 | undefined,
  name: string,
): KrsEntityStatus => {
  if (hasEntries(dzial6?.wykreslenia)) {
    return { type: "dissolved" };
  }
  if (hasEntries(dzial6?.postepowanieUpadlosciowe)) {
    return { type: "bankruptcy" };
  }
  const proceedings =
    dzial6?.postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja;
  if (proceedings && proceedings.length > 0) {
    // `rodzajPostepowania` lives one level down, on the
    // `otwarciePostepowania…` (opening) sub-object — KRS does not
    // put it on the proceeding entry itself. Reading from the wrong
    // level silently turns every real liquidation into an
    // unlabelled record that defaults to restructuring.
    //
    // If ANY entry names a liquidation, the entity is liquidating
    // (a more terminal state than restructuring); otherwise it is
    // restructuring. Entries without a `rodzajPostepowania` count
    // as restructuring rather than liquidation — KRS' default for
    // the unlabelled case is the less terminal arm.
    const anyLiquidation = proceedings.some((entry) =>
      LIQUIDATION_PROCEEDING_PATTERN.test(
        (
          entry
            .otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji
            ?.rodzajPostepowania ??
          entry
            .zakonczeniePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji
            ?.rodzajPostepowania ??
          ""
        ).toUpperCase(),
      ),
    );
    if (anyLiquidation) {
      return { type: "liquidating" };
    }
    const suffixStatus = parseNameSuffixStatus(name);
    return suffixStatus ?? { type: "restructuring" };
  }
  // Fallback: KRS sometimes suffixes the formal name with the
  // proceedings marker before / without the dzial6 entry catching up
  // (the suffix is part of the company's registered name, not a
  // derived status field). Use the name as a secondary signal so a
  // company filed as "ACME SP. Z O.O. W UPADŁOŚCI" surfaces as
  // bankrupt even when dzial6 happens to be empty in the snapshot.
  const suffixStatus = parseNameSuffixStatus(name);
  if (suffixStatus) {
    return suffixStatus;
  }
  // `OdpisAktualny` only returns currently filed entities, so the
  // absence of every lifecycle marker means the entity is operating
  // normally. We surface `active` rather than `unknown` here because
  // the endpoint's semantics guarantee a live record on a 200 hit.
  return { type: "active" };
};

const parseIdentifiers = (odpis: KrsRawOdpis | undefined): KrsIdentifiers => {
  const ids = odpis?.dane?.dzial1?.danePodmiotu?.identyfikatory;
  return {
    nip: trimToNull(ids?.nip),
    regon: trimToNull(ids?.regon),
  };
};

const composeStreetLine = (
  street: string | undefined,
  houseSegment: string,
): string | null => {
  if (street && houseSegment) {
    return `${street} ${houseSegment}`;
  }
  if (street) {
    return street;
  }
  return houseSegment || null;
};

export const parseAddress = (raw: KrsRawAdres): KrsAddress => {
  const houseSegment = [raw.nrDomu, raw.nrLokalu]
    .map((segment) => segment?.trim())
    .filter(Boolean)
    .join(" / ");
  const street = raw.ulica?.trim();
  const streetLine = composeStreetLine(street, houseSegment);
  const city = trimToNull(raw.miejscowosc);
  const postal = trimToNull(raw.kodPocztowy);
  const country = trimToNull(raw.kraj);
  const cityLine = [postal, city].filter(Boolean).join(" ") || null;
  const composite = [streetLine, cityLine, country].filter(Boolean).join(", ");
  return {
    street: streetLine,
    postalCode: postal,
    city,
    country,
    textAddress: composite.length > 0 ? composite : null,
  };
};

const parseSeat = (
  raw: KrsRawSiedziba | undefined,
): KrsRegisteredSeat | null => {
  if (!raw) {
    return null;
  }
  const seat: KrsRegisteredSeat = {
    country: trimToNull(raw.kraj),
    voivodeship: trimToNull(raw.wojewodztwo),
    county: trimToNull(raw.powiat),
    commune: trimToNull(raw.gmina),
    locality: trimToNull(raw.miejscowosc),
  };
  const anyValue =
    seat.country ||
    seat.voivodeship ||
    seat.county ||
    seat.commune ||
    seat.locality;
  return anyValue ? seat : null;
};

// The default mirrors the lookup client's primary probe register —
// a malformed / absent `rejestr` field is vanishingly unlikely on
// a 200 response, so the fallback never fires in practice. Kept to
// make the parser total without coercing a `?` into the public
// shape.
const registerCodeOrDefault = (value: string | undefined): KrsRegisterCode =>
  isKrsRegisterCode(value) ? value : "RejP";

const buildRegistryUrl = (
  krsNumber: string,
  register: KrsRegisterCode,
): string => {
  // `rejestr` carries the API short code (`P` / `S`); the API does
  // not accept the long form (`RejP` / `RejS`) here.
  const shortCode = register === "RejP" ? "P" : "S";
  const params = new URLSearchParams({
    rejestr: shortCode,
    format: "json",
  });
  return `${KRS_API_BASE}/OdpisAktualny/${krsNumber}?${params.toString()}`;
};

export const parseEntity = (
  response: KrsLookupResponse,
  krsNumber: string,
): KrsEntity => {
  const odpis = response.odpis;
  const dane = odpis?.dane;
  const dzial1 = dane?.dzial1;
  const podmiot = dzial1?.danePodmiotu;
  const siedzibaIAdres = dzial1?.siedzibaIAdres;
  const name = podmiot?.nazwa?.trim() ?? krsNumber;
  const register = registerCodeOrDefault(odpis?.naglowekA?.rejestr);
  // KRS dates use DD.MM.YYYY in the payload; we surface them
  // verbatim and leave ISO normalisation to the caller / chat tool
  // which is locale-aware.
  return {
    krsNumber,
    register,
    name,
    legalForm: trimToNull(podmiot?.formaPrawna),
    identifiers: parseIdentifiers(odpis),
    address: siedzibaIAdres?.adres ? parseAddress(siedzibaIAdres.adres) : null,
    registeredSeat: parseSeat(siedzibaIAdres?.siedziba),
    email: trimToNull(siedzibaIAdres?.adresPocztyElektronicznej),
    website: trimToNull(siedzibaIAdres?.adresStronyInternetowej),
    status: parseStatus(dane?.dzial6, name),
    registeredAt: trimToNull(odpis?.naglowekA?.dataRejestracjiWKRS),
    lastEntryAt: trimToNull(odpis?.naglowekA?.dataOstatniegoWpisu),
    registryUrl: buildRegistryUrl(krsNumber, register),
  };
};
