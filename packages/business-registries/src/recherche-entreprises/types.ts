// ---------------------------------------------------------------------------
// Raw recherche-entreprises.api.gouv.fr response shapes
// (https://recherche-entreprises.api.gouv.fr/docs — Etalab, Licence
// Ouverte 2.0, no auth).
//
// Only the fields we surface today are typed. The upstream payload is
// considerably richer (dirigeants, finances, complements, …); extend
// these declarations as we promote more fields into the domain output.
// ---------------------------------------------------------------------------

export type RechercheEntreprisesRawEtablissement = {
  // Etablissement-level identifiers and status. `etat_administratif`
  // is "A" (active) or "F" (closed); upstream may surface other
  // values for partial records, so consumers must treat anything else
  // as "unknown" rather than coerce to "active".
  siret: string;
  etat_administratif?: string | null;
  est_siege?: boolean | null;
  // Composed address line built by upstream (cleaner than re-assembling
  // from the structured atoms below, but occasionally null on minimal
  // records).
  adresse?: string | null;
  // Structured address atoms — kept for callers that need them and as
  // a fallback when `adresse` is null.
  numero_voie?: string | null;
  type_voie?: string | null;
  libelle_voie?: string | null;
  complement_adresse?: string | null;
  code_postal?: string | null;
  libelle_commune?: string | null;
  libelle_commune_etranger?: string | null;
  libelle_pays_etranger?: string | null;
  code_pays_etranger?: string | null;
  // Activity code (NAF rev. 2 / NAF 2008): "29.10Z" for car manufacture.
  activite_principale?: string | null;
  date_creation?: string | null;
  date_fermeture?: string | null;
};

export type RechercheEntreprisesRawDirigeantPerson = {
  type_dirigeant: "personne physique";
  nom?: string | null;
  prenoms?: string | null;
  qualite?: string | null;
  annee_de_naissance?: string | null;
  date_de_naissance?: string | null;
  nationalite?: string | null;
};

export type RechercheEntreprisesRawDirigeantOrganisation = {
  type_dirigeant: "personne morale";
  siren?: string | null;
  denomination?: string | null;
  qualite?: string | null;
};

export type RechercheEntreprisesRawDirigeant =
  | RechercheEntreprisesRawDirigeantPerson
  | RechercheEntreprisesRawDirigeantOrganisation;

export type RechercheEntreprisesRawUniteLegale = {
  // Unité légale (legal entity) identifiers.
  siren: string;
  nom_complet: string;
  nom_raison_sociale?: string | null;
  sigle?: string | null;
  // Top-level `etat_administratif` mirrors INSEE's unité-légale state:
  // "A" = active, "C" = cessée (definitively closed). Optional on the
  // upstream schema; the parser surfaces "unknown" when missing or for
  // undocumented values rather than assuming "active".
  etat_administratif?: string | null;
  // INSEE "nature juridique" 4-digit code — e.g. "5710" = SAS,
  // "5499" = SA. Translated to a human description via INSEE's
  // categorie_juridique lookup table; here we only surface the code
  // (translation lives in a future enrichment pass).
  nature_juridique?: string | null;
  date_creation?: string | null;
  date_fermeture?: string | null;
  // Always-on-records: the head office (siège). Even ceased entities
  // retain their last known siège, so this field is not nullable in
  // practice — but the upstream schema does not guarantee it, so the
  // parser must tolerate absence.
  siege?: RechercheEntreprisesRawEtablissement | null;
  // Populated when the search/lookup is keyed by SIRET: the specific
  // etablissement that matched. Empty array for SIREN queries.
  matching_etablissements?: RechercheEntreprisesRawEtablissement[];
  dirigeants?: RechercheEntreprisesRawDirigeant[];
};

export type RechercheEntreprisesSearchResponse = {
  results: RechercheEntreprisesRawUniteLegale[];
  total_results: number;
  page: number;
  per_page: number;
  total_pages: number;
};

export type RechercheEntreprisesErrorResponse = {
  // Upstream surfaces errors as JSON envelopes with at least a
  // `message` field on 4xx/5xx responses.
  message?: string;
  erreur?: string;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type RechercheEntreprisesAddress = {
  // Composed `adresse` from upstream when present; otherwise rebuilt
  // from atoms.
  textAddress: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
};

// Etablissement-level status: "A" = ouvert, "F" = fermé.
export type RechercheEntreprisesEstablishmentStatus =
  | { type: "open" }
  | { type: "closed"; closedAt: string | null }
  | { type: "unknown" };

// Unité-légale-level status: "A" = active, "C" = cessée.
export type RechercheEntreprisesLegalEntityStatus =
  | { type: "active" }
  | { type: "ceased"; ceasedAt: string | null }
  | { type: "unknown" };

export type RechercheEntreprisesEstablishment = {
  siret: string;
  isHeadOffice: boolean;
  address: RechercheEntreprisesAddress | null;
  activityCode: string | null;
  status: RechercheEntreprisesEstablishmentStatus;
  createdAt: string | null;
  closedAt: string | null;
};

export type RechercheEntreprisesDirector =
  | {
      type: "person";
      fullName: string;
      role: string | null;
      birthYear: string | null;
    }
  | {
      type: "organisation";
      siren: string | null;
      name: string;
      role: string | null;
    };

export type RechercheEntreprisesCompany = {
  siren: string;
  name: string;
  // INSEE legal-form code (categorie_juridique). Translation to a
  // human description lives in a future enrichment pass — see notes
  // in `parse.ts`.
  legalFormCode: string | null;
  // Trade abbreviation ("sigle"), e.g. "EDF" for Électricité de France.
  shortName: string | null;
  // Head office (siège social). Null when upstream omits it, which
  // should not happen for active entities but is allowed by the
  // schema.
  headOffice: RechercheEntreprisesEstablishment | null;
  // The specific etablissement that matched when the query was a
  // SIRET; null for SIREN lookups and name searches.
  matchedEstablishment: RechercheEntreprisesEstablishment | null;
  status: RechercheEntreprisesLegalEntityStatus;
  registeredAt: string | null;
  ceasedAt: string | null;
  directors: RechercheEntreprisesDirector[];
  registryUrl: string;
};

export type RechercheEntreprisesSearchResult = {
  siren: string;
  name: string;
  address: string | null;
};
