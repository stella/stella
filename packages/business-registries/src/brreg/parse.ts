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

const BRREG_ENTITY_URL = "https://virksomhet.brreg.no/nb/oppslag/enheter/";

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
  if (raw.slettedato) {
    return { type: "deleted", deletedAt: raw.slettedato };
  }
  if (raw.konkurs === true) {
    return { type: "bankruptcy" };
  }
  if (
    raw.underAvvikling === true ||
    raw.underTvangsavviklingEllerTvangsopplosning === true
  ) {
    return { type: "winding_up" };
  }
  return { type: "active" };
};

export const parseEnhet = (raw: BrregRawEnhet): BrregEntity => {
  // Parent entities (`/enheter`) carry the physical address as
  // `forretningsadresse`; sub-entities (`/underenheter`) use
  // `beliggenhetsadresse`. Same domain field, different upstream key.
  const physicalAddress = raw.forretningsadresse ?? raw.beliggenhetsadresse;
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
    registryUrl: `${BRREG_ENTITY_URL}${raw.organisasjonsnummer}`,
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
