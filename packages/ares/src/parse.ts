import type {
  AresAddress,
  AresBodyMember,
  AresCourtFile,
  AresCompany,
  AresRawAddress,
  AresResRecord,
  AresSearchEntry,
  AresSearchResult,
  AresStatutoryBody,
  AresVrBodyMember,
  AresVrPrimaryRecord,
  AresVrResponse,
  AresVrSpisZn,
  AresVrStatutoryBody,
} from "./types.js";

const ARES_RES_URL = "https://ares.gov.cz/ekonomicke-subjekty?ico=";

const CURRENCIES: Record<string, string> = {
  KORUNY: "Kc",
  EURA: "EUR",
  EUR: "EUR",
};

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

export const parseAddress = (raw: AresRawAddress): AresAddress => ({
  street: raw.nazevUlice ?? null,
  houseNumber: raw.cisloDomovni !== undefined ? String(raw.cisloDomovni) : null,
  orientationNumber:
    raw.cisloOrientacni !== undefined ? String(raw.cisloOrientacni) : null,
  orientationLetter: raw.cisloOrientacniPismeno ?? null,
  municipalityPart: raw.nazevCastiObce ?? null,
  municipality: raw.nazevMestskehoObvodu || raw.nazevObce || null,
  postalCode: raw.psc !== undefined ? String(raw.psc) : (raw.pscTxt ?? null),
  district: raw.nazevOkresu ?? null,
  country: raw.nazevStatu ?? null,
  textAddress: raw.textovaAdresa ?? null,
});

export const formatTextAddress = (raw: AresRawAddress): string | null =>
  raw.textovaAdresa || null;

// ---------------------------------------------------------------------------
// RES record → AresCompany (partial, without VR fields)
// ---------------------------------------------------------------------------

export const parseResRecord = (record: AresResRecord): AresCompany => ({
  ico: record.ico,
  name: record.obchodniJmeno,
  legalForm: record.pravniForma ?? null,
  address: record.sidlo ? parseAddress(record.sidlo) : null,
  dateEstablished: record.datumVzniku ?? null,
  dateRegistered: record.datumZapisu ?? null,
  czNace: record.czNace ?? [],
  registryUrl: `${ARES_RES_URL}${record.ico}`,
  status: null,
  courtFile: null,
  shareCapital: null,
  statutoryBodies: [],
  actingClause: null,
});

// ---------------------------------------------------------------------------
// VR helpers
// ---------------------------------------------------------------------------

/** Find the most recent non-deleted entry from a list with validity dates. */
const findCurrentEntry = <T extends { datumVymazu?: string }>(
  entries: T[] | undefined,
): T | undefined => entries?.find((e) => !e.datumVymazu);

/** Extract court file reference from VR data. */
const parseCourtFile = (
  entries: AresVrSpisZn[] | undefined,
): AresCourtFile | null => {
  const entry = findCurrentEntry(entries);
  if (!entry?.soud || !entry.oddil || !entry.vlozka) {
    return null;
  }
  return {
    court: entry.soud,
    section: entry.oddil,
    insert: entry.vlozka,
  };
};

/** Format monetary value from VR (e.g. "50000;00" KORUNY → "50 000,- Kc"). */
const formatMoney = (
  value: string | undefined,
  currency: string | undefined,
): string | null => {
  if (!value) {
    return null;
  }
  const currencyStr = currency ? (CURRENCIES[currency] ?? currency) : "";
  try {
    const numeric = value.split(";", 1).at(0) ?? value;
    const formatted = Number(numeric)
      .toLocaleString("cs-CZ")
      .replace(/\u00a0/g, " ");
    return `${formatted},- ${currencyStr}`.trim();
  } catch {
    return `${value} ${currencyStr}`.trim();
  }
};

/** Extract share capital from VR data. */
const parseShareCapital = (
  entries: AresVrPrimaryRecord["zakladniKapital"],
): string | null => {
  if (!entries) {
    return null;
  }
  for (const entry of entries) {
    if (entry.datumVymazu) {
      continue;
    }
    const deposit = entry.vklad;
    if (!deposit?.hodnota) {
      continue;
    }
    return formatMoney(deposit.hodnota, deposit.typObnos);
  }
  return null;
};

/** Build full name from a VR physical person. */
const buildPersonName = (member: AresVrBodyMember): string | null => {
  const person = member.fyzickaOsoba ?? member.osoba?.fyzickaOsoba;
  if (person) {
    const parts = [
      person.titulPredJmenem?.trim(),
      person.jmeno,
      person.prijmeni,
      person.titulZaJmenem?.trim(),
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  const entity = member.pravnickaOsoba ?? member.osoba?.pravnickaOsoba;
  if (entity?.obchodniJmeno) {
    return entity.obchodniJmeno;
  }
  return null;
};

/** Extract member address as text. */
const buildMemberAddress = (member: AresVrBodyMember): string | null => {
  const addr =
    member.adresa ??
    member.pravnickaOsoba?.adresa ??
    member.osoba?.pravnickaOsoba?.adresa;
  if (addr?.textovaAdresa) {
    return addr.textovaAdresa;
  }
  return null;
};

/** Extract all statutory bodies and their members from VR data. */
const parseStatutoryBodies = (
  bodies: AresVrStatutoryBody[] | undefined,
): AresStatutoryBody[] => {
  if (!bodies) {
    return [];
  }
  const result: AresStatutoryBody[] = [];

  for (const body of bodies) {
    if (body.datumVymazu) {
      continue;
    }
    const organName = body.nazevOrganu ?? "Statutarni organ";
    const members: AresBodyMember[] = [];

    for (const member of body.clenoveOrganu ?? []) {
      if (member.datumVymazu) {
        continue;
      }
      const name = buildPersonName(member);
      if (!name) {
        continue;
      }

      const role =
        member.clenstvi?.funkce?.nazev ??
        member.osoba?.nazevAngazma ??
        member.nazevAngazma ??
        null;

      const since = member.clenstvi?.clenstvi?.vznikClenstvi ?? null;

      members.push({
        name,
        role,
        address: buildMemberAddress(member),
        since,
      });
    }

    if (members.length > 0) {
      result.push({ organName, members });
    }
  }

  return result;
};

/** Extract the acting clause from VR data. */
const parseActingClause = (
  bodies: AresVrStatutoryBody[] | undefined,
): string | null => {
  if (!bodies) {
    return null;
  }
  const parts: string[] = [];
  for (const body of bodies) {
    if (body.datumVymazu) {
      continue;
    }
    for (const entry of body.zpusobJednani ?? []) {
      if (entry.datumVymazu) {
        continue;
      }
      if (entry.hodnota) {
        parts.push(entry.hodnota);
      }
    }
  }
  return parts.length > 0 ? parts.join(" ").trim() : null;
};

// ---------------------------------------------------------------------------
// Merge RES + VR into AresCompany
// ---------------------------------------------------------------------------

/** Enrich a RES-based AresCompany with data from the VR register. */
export const enrichWithVr = (
  company: AresCompany,
  vrResponse: AresVrResponse,
): AresCompany => {
  const primary = vrResponse.zaznamy.find((z) => z.primarniZaznam);
  if (!primary) {
    return company;
  }

  // Prefer VR address if available (usually more detailed)
  const currentVrAddress = findCurrentEntry(primary.adresy);
  const address = currentVrAddress?.adresa
    ? parseAddress(currentVrAddress.adresa)
    : company.address;

  // Company name from VR (most recent, non-deleted)
  const currentName = findCurrentEntry(primary.obchodniJmeno);
  const name = currentName?.hodnota ?? company.name;

  // Date established from VR
  const vrDateEstablished =
    primary.datumVzniku?.at(0)?.hodnota ?? company.dateEstablished;

  // All statutory bodies (statutarni + ostatni)
  const allBodies = [
    ...(primary.statutarniOrgany ?? []),
    ...(primary.ostatniOrgany ?? []),
  ];

  return {
    ...company,
    name,
    address,
    dateEstablished: vrDateEstablished,
    dateRegistered: primary.datumZapisu ?? company.dateRegistered,
    status: vrResponse.stavSubjektu ?? company.status,
    courtFile: parseCourtFile(primary.spisovaZnacka),
    shareCapital: parseShareCapital(primary.zakladniKapital),
    statutoryBodies: parseStatutoryBodies(allBodies),
    actingClause: parseActingClause(primary.statutarniOrgany),
  };
};

// ---------------------------------------------------------------------------
// Search result parsing
// ---------------------------------------------------------------------------

export const parseSearchEntry = (entry: AresSearchEntry): AresSearchResult => ({
  ico: entry.ico ?? "",
  name: entry.obchodniJmeno,
  address: entry.sidlo?.textovaAdresa ?? null,
});
