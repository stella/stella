// ---------------------------------------------------------------------------
// Raw ARES API response types (RES register)
// ---------------------------------------------------------------------------

/** Address object as returned by ARES API. */
export type AresRawAddress = {
  kodStatu?: string;
  nazevStatu?: string;
  nazevObce?: string;
  nazevMestskehoObvodu?: string;
  nazevCastiObce?: string;
  nazevUlice?: string;
  cisloDomovni?: number | null;
  cisloOrientacni?: number | null;
  cisloOrientacniPismeno?: string;
  psc?: number | null;
  pscTxt?: string;
  textovaAdresa?: string;
  nazevOkresu?: string;
  nazevKraje?: string;
};

/** Single record within the RES endpoint response. */
export type AresResRecord = {
  ico: string;
  obchodniJmeno: string;
  sidlo?: AresRawAddress;
  pravniForma?: string;
  datumVzniku?: string;
  datumZapisu?: string;
  datumAktualizace?: string;
  czNace?: string[];
  czNacePrevazujici?: string;
  primarniZaznam: boolean;
  statistickeUdaje?: {
    kategorieZamestnancu?: string;
    klasifikaceEkonomickychCinnosti?: {
      kodNace?: string;
    };
  };
};

/** Top-level response from the RES endpoint. */
export type AresResResponse = {
  icoId: string;
  zaznamy: AresResRecord[];
};

// ---------------------------------------------------------------------------
// Raw ARES API response types (VR register)
// ---------------------------------------------------------------------------

/** Address entry in VR records (has validity dates). */
export type AresVrAddressEntry = {
  adresa?: AresRawAddress;
  datumZapisu?: string;
  datumVymazu?: string;
};

/** Company name entry with validity dates. */
export type AresVrNameEntry = {
  hodnota: string;
  datumZapisu?: string;
  datumVymazu?: string;
};

/** Spis. značka (court file reference). */
export type AresVrSpisZn = {
  soud?: string;
  oddil?: string;
  vlozka?: string;
  datumZapisu?: string;
  datumVymazu?: string;
};

/** Capital/deposit value. */
export type AresVrDeposit = {
  hodnota?: string;
  typObnos?: string;
};

/** Share capital entry. */
export type AresVrShareCapital = {
  vklad?: AresVrDeposit;
  datumZapisu?: string;
  datumVymazu?: string;
};

/** Legal form entry with validity dates. */
export type AresVrLegalFormEntry = {
  hodnota?: string;
  datumZapisu?: string;
  datumVymazu?: string;
};

/** Physical person in VR data. */
export type AresVrPhysicalPerson = {
  jmeno?: string;
  prijmeni?: string;
  titulPredJmenem?: string;
  titulZaJmenem?: string;
  datumNarozeni?: string;
  statniObcanstvi?: string;
};

/** Legal entity in VR data. */
export type AresVrLegalEntity = {
  obchodniJmeno?: string;
  ico?: string;
  adresa?: AresRawAddress;
};

/** Individual member of a statutory body. */
export type AresVrBodyMember = {
  fyzickaOsoba?: AresVrPhysicalPerson;
  pravnickaOsoba?: AresVrLegalEntity;
  osoba?: {
    fyzickaOsoba?: AresVrPhysicalPerson;
    pravnickaOsoba?: AresVrLegalEntity;
    nazevAngazma?: string;
  };
  clenstvi?: {
    clenstvi?: {
      vznikClenstvi?: string;
      zanikClenstvi?: string;
    };
    funkce?: {
      nazev?: string;
    };
  };
  nazevAngazma?: string;
  datumVymazu?: string;
  adresa?: AresRawAddress;
};

/** Statutory body (e.g. board of directors). */
export type AresVrStatutoryBody = {
  nazevOrganu?: string;
  clenoveOrganu?: AresVrBodyMember[];
  zpusobJednani?: { hodnota?: string; datumVymazu?: string }[];
  datumVymazu?: string;
};

/** Primary record from the VR endpoint. */
export type AresVrPrimaryRecord = {
  obchodniJmeno?: AresVrNameEntry[];
  ico?: { hodnota?: string }[];
  adresy?: AresVrAddressEntry[];
  pravniForma?: AresVrLegalFormEntry[] | string;
  spisovaZnacka?: AresVrSpisZn[];
  zakladniKapital?: AresVrShareCapital[];
  statutarniOrgany?: AresVrStatutoryBody[];
  ostatniOrgany?: AresVrStatutoryBody[];
  datumVzniku?: { hodnota?: string }[];
  datumZapisu?: string;
  primarniZaznam: boolean;
};

/** Top-level response from the VR endpoint. */
export type AresVrResponse = {
  icoId: string;
  zaznamy: AresVrPrimaryRecord[];
  stavSubjektu?: string;
  datumAktualizace?: string;
};

// ---------------------------------------------------------------------------
// Raw ARES search response
// ---------------------------------------------------------------------------

/** Single entry in a name-search response. */
export type AresSearchEntry = {
  ico?: string;
  obchodniJmeno: string;
  sidlo?: AresRawAddress;
  pravniForma?: string;
};

/** Top-level response from the search endpoint. */
export type AresSearchResponse = {
  pocetCelkem: number;
  ekonomickeSubjekty: AresSearchEntry[];
};

// ---------------------------------------------------------------------------
// Raw ARES code list response
// ---------------------------------------------------------------------------

export type AresCodeListItem = {
  kod: string;
  nazev?: { nazev?: string }[];
  platnostOd?: string;
  platnostDo?: string;
};

export type AresCodeListResponse = {
  pocetCelkem: number;
  ciselniky?: {
    polozkyCiselniku?: AresCodeListItem[];
  }[];
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type AresAddress = {
  street: string | null;
  houseNumber: string | null;
  orientationNumber: string | null;
  orientationLetter: string | null;
  municipalityPart: string | null;
  municipality: string | null;
  postalCode: string | null;
  district: string | null;
  country: string | null;
  textAddress: string | null;
};

export type AresCourtFile = {
  court: string;
  section: string;
  insert: string;
};

export type AresBodyMember = {
  name: string;
  role: string | null;
  address: string | null;
  since: string | null;
};

export type AresStatutoryBody = {
  organName: string;
  members: AresBodyMember[];
};

export type AresCompany = {
  ico: string;
  name: string;
  legalForm: string | null;
  address: AresAddress | null;
  dateEstablished: string | null;
  dateRegistered: string | null;
  czNace: string[];
  registryUrl: string;
  status: string | null;
  // VR-enriched fields (null when entity is not in commercial register)
  courtFile: AresCourtFile | null;
  shareCapital: string | null;
  statutoryBodies: AresStatutoryBody[];
  actingClause: string | null;
};

export type AresSearchResult = {
  ico: string;
  name: string;
  address: string | null;
};

// ---------------------------------------------------------------------------
// ARES error response shape
// ---------------------------------------------------------------------------

export type AresErrorResponse = {
  kod?: string;
  subKod?: string;
  popis?: string;
};
