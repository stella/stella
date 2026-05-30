import type {
  RechercheEntreprisesAddress,
  RechercheEntreprisesCompany,
  RechercheEntreprisesDirector,
  RechercheEntreprisesEstablishment,
  RechercheEntreprisesEstablishmentStatus,
  RechercheEntreprisesLegalEntityStatus,
  RechercheEntreprisesRawDirigeant,
  RechercheEntreprisesRawEtablissement,
  RechercheEntreprisesRawUniteLegale,
  RechercheEntreprisesSearchResult,
} from "./types.js";

// The official "annuaire des entreprises" search page is the
// human-readable surface for a unité légale; it accepts the SIREN
// directly in the URL path and resolves to the same record the API
// returns. Use it as the provenance link so reviewers can verify
// adapter output against the source of truth in one click.
const ANNUAIRE_BASE = "https://annuaire-entreprises.data.gouv.fr/entreprise/";

const STATUS_ACTIVE = "A";
const STATUS_CEASED = "C";

const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const buildStreetFromAtoms = (
  raw: RechercheEntreprisesRawEtablissement,
): string | null => {
  // Recherche-entreprises supplies a pre-composed `adresse` string for
  // most records; we only fall back to atom-by-atom reconstruction when
  // it is missing. The fallback uses the same INSEE atoms the upstream
  // composer uses (numero_voie + type_voie + libelle_voie) so the
  // output stays consistent.
  const parts = [
    trimToNull(raw.numero_voie),
    trimToNull(raw.type_voie),
    trimToNull(raw.libelle_voie),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" ");
};

export const parseAddress = (
  raw: RechercheEntreprisesRawEtablissement,
): RechercheEntreprisesAddress | null => {
  const street = trimToNull(raw.adresse) ?? buildStreetFromAtoms(raw);
  const postalCode = trimToNull(raw.code_postal);
  const city =
    trimToNull(raw.libelle_commune) ?? trimToNull(raw.libelle_commune_etranger);
  const country =
    trimToNull(raw.libelle_pays_etranger) ?? trimToNull(raw.code_pays_etranger);
  if (!street && !postalCode && !city && !country) {
    return null;
  }
  // When `adresse` is already populated by upstream it generally
  // includes the postal code + commune; rebuild a stable composite
  // for callers that just want one human-readable line, but prefer the
  // upstream `adresse` verbatim when it is present.
  const composite =
    trimToNull(raw.adresse) ??
    [street, [postalCode, city].filter(Boolean).join(" ") || null, country]
      .filter(Boolean)
      .join(", ");
  return {
    textAddress: composite.length > 0 ? composite : null,
    street,
    postalCode,
    city,
    country,
  };
};

const parseEstablishmentStatus = (
  raw: RechercheEntreprisesRawEtablissement,
): RechercheEntreprisesEstablishmentStatus => {
  const etat = trimToNull(raw.etat_administratif);
  if (etat === STATUS_ACTIVE) {
    return { type: "open" };
  }
  if (etat === STATUS_CEASED) {
    return { type: "closed", closedAt: trimToNull(raw.date_fermeture) };
  }
  return { type: "unknown" };
};

const parseLegalEntityStatus = (
  raw: RechercheEntreprisesRawUniteLegale,
): RechercheEntreprisesLegalEntityStatus => {
  const etat = trimToNull(raw.etat_administratif);
  if (etat === STATUS_ACTIVE) {
    return { type: "active" };
  }
  if (etat === STATUS_CEASED) {
    return { type: "ceased", ceasedAt: trimToNull(raw.date_fermeture) };
  }
  return { type: "unknown" };
};

export const parseEstablishment = (
  raw: RechercheEntreprisesRawEtablissement,
): RechercheEntreprisesEstablishment => ({
  siret: raw.siret,
  isHeadOffice: raw.est_siege === true,
  address: parseAddress(raw),
  activityCode: trimToNull(raw.activite_principale),
  status: parseEstablishmentStatus(raw),
  createdAt: trimToNull(raw.date_creation),
  closedAt: trimToNull(raw.date_fermeture),
});

const parseDirector = (
  raw: RechercheEntreprisesRawDirigeant,
): RechercheEntreprisesDirector | null => {
  if (raw.type_dirigeant === "personne physique") {
    const surname = trimToNull(raw.nom);
    const given = trimToNull(raw.prenoms);
    const fullName =
      [given, surname].filter((part): part is string => part !== null).join(" ")
        .length > 0
        ? [given, surname]
            .filter((part): part is string => part !== null)
            .join(" ")
        : null;
    if (!fullName) {
      // Skip entries without any name on file rather than emit an
      // empty-string director — upstream occasionally returns rows
      // with both `nom` and `prenoms` null on minimal records.
      return null;
    }
    return {
      type: "person",
      fullName,
      role: trimToNull(raw.qualite),
      birthYear: trimToNull(raw.annee_de_naissance),
    };
  }
  const name = trimToNull(raw.denomination);
  if (!name) {
    return null;
  }
  return {
    type: "organisation",
    siren: trimToNull(raw.siren),
    name,
    role: trimToNull(raw.qualite),
  };
};

const parseDirectors = (
  raws: RechercheEntreprisesRawDirigeant[] | undefined,
): RechercheEntreprisesDirector[] => {
  if (!raws) {
    return [];
  }
  return raws
    .map(parseDirector)
    .filter((entry): entry is RechercheEntreprisesDirector => entry !== null);
};

/**
 * Parse a unité légale into a domain `RechercheEntreprisesCompany`.
 *
 * @param raw - Upstream payload from `/search`.
 * @param matchedSiret - When the caller queried by SIRET, the specific
 *   SIRET they asked about. The parser surfaces the matching
 *   etablissement separately so callers can render "this is the
 *   specific establishment you asked about" UX without re-matching.
 */
export const parseCompany = (
  raw: RechercheEntreprisesRawUniteLegale,
  matchedSiret?: string,
): RechercheEntreprisesCompany => {
  const headOffice = raw.siege ? parseEstablishment(raw.siege) : null;
  const matched = matchedSiret
    ? (raw.matching_etablissements?.find(
        (entry) => entry.siret === matchedSiret,
      ) ?? null)
    : null;
  return {
    siren: raw.siren,
    name: raw.nom_complet,
    legalFormCode: trimToNull(raw.nature_juridique),
    shortName: trimToNull(raw.sigle),
    headOffice,
    matchedEstablishment: matched ? parseEstablishment(matched) : null,
    status: parseLegalEntityStatus(raw),
    registeredAt: trimToNull(raw.date_creation),
    ceasedAt: trimToNull(raw.date_fermeture),
    directors: parseDirectors(raw.dirigeants),
    registryUrl: `${ANNUAIRE_BASE}${encodeURIComponent(raw.siren)}`,
  };
};

export const parseSearchEntry = (
  raw: RechercheEntreprisesRawUniteLegale,
): RechercheEntreprisesSearchResult => ({
  siren: raw.siren,
  name: raw.nom_complet,
  address: raw.siege ? (parseAddress(raw.siege)?.textAddress ?? null) : null,
});
