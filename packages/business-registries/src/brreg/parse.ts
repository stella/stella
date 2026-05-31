import type {
  BrregAddress,
  BrregEntity,
  BrregEntityStatus,
  BrregIndustryCode,
  BrregRawAddress,
  BrregRawEnhet,
  BrregRawNaeringskode,
  BrregSearchResult,
} from "./types.js";

const BRREG_ENHET_URL = "https://virksomhet.brreg.no/nb/oppslag/enheter/";
const BRREG_UNDERENHET_URL =
  "https://virksomhet.brreg.no/nb/oppslag/underenheter/";

// Discriminator for which Brreg register a raw entity came from. The
// public registry UI separates main entities and sub-entities under
// different URL paths, so the parser needs to know which to link to.
export type BrregEnhetKind = "enhet" | "underenhet";

export const parseAddress = (raw: BrregRawAddress): BrregAddress => {
  const lines = raw.adresse?.filter(Boolean) ?? [];
  // Compose textAddress from whichever fields are present. Brreg
  // sometimes returns a postal address with no street lines (PO box
  // entries, or sub-entities registered to a kommune-level
  // address); we still want a usable single-line representation
  // rather than null.
  const composite = [
    lines.length > 0 ? lines.join(", ") : null,
    [raw.postnummer, raw.poststed].filter(Boolean).join(" ") || null,
    raw.land,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    street: lines.at(0) ?? null,
    postalCode: raw.postnummer ?? null,
    city: raw.poststed ?? null,
    municipality: raw.kommune ?? null,
    country: raw.land ?? null,
    textAddress: composite.length > 0 ? composite : null,
  };
};

const parseIndustry = (
  raw: BrregRawNaeringskode | undefined,
): BrregIndustryCode | null => {
  if (!raw?.kode) {
    return null;
  }
  return { code: raw.kode, description: raw.beskrivelse ?? null };
};

const collectIndustryCodes = (raw: BrregRawEnhet): BrregIndustryCode[] => {
  const codes: BrregIndustryCode[] = [];
  for (const candidate of [
    raw.naeringskode1,
    raw.naeringskode2,
    raw.naeringskode3,
  ]) {
    const parsed = parseIndustry(candidate);
    if (parsed) {
      codes.push(parsed);
    }
  }
  return codes;
};

const parseStatus = (raw: BrregRawEnhet): BrregEntityStatus => {
  // Brreg encodes "no longer operating" with two distinct fields:
  //   * slettedato — the register removed the record entirely
  //   * nedleggelsesdato — a sub-entity ceased operations but the
  //     record itself is retained (sub-entities only)
  // Both map to the "deleted" arm of our domain union; callers that
  // need to tell them apart can look at the raw payload.
  const removedAt = raw.slettedato ?? raw.nedleggelsesdato;
  if (removedAt) {
    return { type: "deleted", deletedAt: removedAt };
  }
  if (raw.konkurs === true) {
    return { type: "bankruptcy", openedAt: raw.konkursdato ?? null };
  }
  // Compulsory liquidation precedes voluntary liquidation on purpose:
  // Brreg can set both flags during a transition, and the compulsory
  // proceeding is the more material legal regime.
  if (raw.underTvangsavviklingEllerTvangsopplosning === true) {
    // Brreg has no single "compulsory liquidation date" field; the
    // opening date lives on whichever reason-specific column applies
    // (failure to file accounts, missing auditor, defective board,
    // failure to delete). Pick the first populated one.
    const openedAt =
      raw.tvangsopplostPgaManglendeRegnskapDato ??
      raw.tvangsopplostPgaManglendeRevisorDato ??
      raw.tvangsopplostPgaMangelfulltStyreDato ??
      raw.tvangsavvikletPgaManglendeSlettingDato ??
      null;
    return { type: "compulsory_liquidation", openedAt };
  }
  if (raw.underAvvikling === true) {
    return {
      type: "voluntary_liquidation",
      openedAt: raw.underAvviklingDato ?? null,
    };
  }
  return { type: "active" };
};

export const parseEnhet = (
  raw: BrregRawEnhet,
  kind: BrregEnhetKind = "enhet",
): BrregEntity => {
  // Parent entities (`/enheter`) carry the physical address as
  // `forretningsadresse`; sub-entities (`/underenheter`) use
  // `beliggenhetsadresse`. Same domain field, different upstream key.
  const physicalAddress = raw.forretningsadresse ?? raw.beliggenhetsadresse;
  const base = kind === "underenhet" ? BRREG_UNDERENHET_URL : BRREG_ENHET_URL;
  return {
    orgnr: raw.organisasjonsnummer,
    name: raw.navn,
    legalForm: raw.organisasjonsform?.beskrivelse ?? null,
    legalFormCode: raw.organisasjonsform?.kode ?? null,
    businessAddress: physicalAddress ? parseAddress(physicalAddress) : null,
    postalAddress: raw.postadresse ? parseAddress(raw.postadresse) : null,
    registeredAt: raw.registreringsdatoEnhetsregisteret ?? null,
    establishedAt: raw.stiftelsesdato ?? null,
    industryCodes: collectIndustryCodes(raw),
    numberOfEmployees:
      typeof raw.antallAnsatte === "number" ? raw.antallAnsatte : null,
    status: parseStatus(raw),
    vatRegistered: raw.registrertIMvaregisteret === true,
    registryUrl: `${base}${raw.organisasjonsnummer}`,
  };
};

export const parseSearchEntry = (raw: BrregRawEnhet): BrregSearchResult => {
  const physicalAddress = raw.forretningsadresse ?? raw.beliggenhetsadresse;
  const address = physicalAddress
    ? parseAddress(physicalAddress).textAddress
    : null;
  return {
    orgnr: raw.organisasjonsnummer,
    name: raw.navn,
    address,
  };
};
