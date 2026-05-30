import { describe, expect, test } from "bun:test";

import {
  parseAddress,
  parseCompany,
  parseEstablishment,
  parseSearchEntry,
} from "./parse.js";
import type {
  RechercheEntreprisesRawEtablissement,
  RechercheEntreprisesRawUniteLegale,
} from "./types.js";

const baseEtablissement: RechercheEntreprisesRawEtablissement = {
  siret: "78012998704037",
};

describe("parseAddress", () => {
  test("prefers the composed `adresse` line when present", () => {
    // recherche-entreprises serves a pre-composed address on most
    // records; the parser must not re-derive from atoms (and risk
    // diverging from the upstream string) when `adresse` is set.
    const address = parseAddress({
      ...baseEtablissement,
      adresse:
        "122-122 122 B AVENUE DU GENERAL LECLERC 92100 BOULOGNE-BILLANCOURT",
      code_postal: "92100",
      libelle_commune: "BOULOGNE-BILLANCOURT",
      numero_voie: "122",
      type_voie: "AVENUE",
      libelle_voie: "DU GENERAL LECLERC",
    });
    expect(address?.textAddress).toBe(
      "122-122 122 B AVENUE DU GENERAL LECLERC 92100 BOULOGNE-BILLANCOURT",
    );
    expect(address?.street).toBe(
      "122-122 122 B AVENUE DU GENERAL LECLERC 92100 BOULOGNE-BILLANCOURT",
    );
    expect(address?.postalCode).toBe("92100");
    expect(address?.city).toBe("BOULOGNE-BILLANCOURT");
  });

  test("rebuilds the street from atoms when `adresse` is missing", () => {
    const address = parseAddress({
      ...baseEtablissement,
      numero_voie: "59",
      type_voie: "RUE",
      libelle_voie: "LA FAYETTE",
      code_postal: "75009",
      libelle_commune: "PARIS",
    });
    expect(address?.street).toBe("59 RUE LA FAYETTE");
    expect(address?.textAddress).toContain("59 RUE LA FAYETTE");
    expect(address?.textAddress).toContain("75009 PARIS");
  });

  test("returns null when the etablissement has no address fields", () => {
    expect(parseAddress(baseEtablissement)).toBeNull();
  });

  test("falls back to libelle_pays_etranger for foreign addresses", () => {
    const address = parseAddress({
      ...baseEtablissement,
      adresse: "100 Liverpool Street, LONDON",
      libelle_commune_etranger: "LONDON",
      libelle_pays_etranger: "ROYAUME-UNI",
    });
    expect(address?.city).toBe("LONDON");
    expect(address?.country).toBe("ROYAUME-UNI");
  });
});

describe("parseEstablishment status", () => {
  test("maps etat_administratif=A → open", () => {
    expect(
      parseEstablishment({ ...baseEtablissement, etat_administratif: "A" })
        .status,
    ).toEqual({ type: "open" });
  });

  test("maps etat_administratif=C → closed with closedAt", () => {
    expect(
      parseEstablishment({
        ...baseEtablissement,
        etat_administratif: "C",
        date_fermeture: "2020-06-30",
      }).status,
    ).toEqual({ type: "closed", closedAt: "2020-06-30" });
  });

  test("surfaces unknown for missing or undocumented etat values", () => {
    expect(parseEstablishment(baseEtablissement).status).toEqual({
      type: "unknown",
    });
    expect(
      parseEstablishment({ ...baseEtablissement, etat_administratif: "X" })
        .status,
    ).toEqual({ type: "unknown" });
  });

  test("flags head office via est_siege", () => {
    expect(
      parseEstablishment({ ...baseEtablissement, est_siege: true })
        .isHeadOffice,
    ).toBe(true);
    expect(
      parseEstablishment({ ...baseEtablissement, est_siege: false })
        .isHeadOffice,
    ).toBe(false);
    // Defensive: missing flag → not a head office.
    expect(parseEstablishment(baseEtablissement).isHeadOffice).toBe(false);
  });
});

describe("parseCompany", () => {
  const minimal: RechercheEntreprisesRawUniteLegale = {
    siren: "780129987",
    nom_complet: "RENAULT SAS",
    etat_administratif: "A",
  };

  test("returns active status when etat_administratif=A", () => {
    expect(parseCompany(minimal).status).toEqual({ type: "active" });
  });

  test("returns ceased status with ceasedAt when etat_administratif=C", () => {
    expect(
      parseCompany({
        ...minimal,
        etat_administratif: "C",
        date_fermeture: "2024-01-15",
      }).status,
    ).toEqual({ type: "ceased", ceasedAt: "2024-01-15" });
  });

  test("returns unknown status when etat_administratif is missing", () => {
    const { etat_administratif, ...rest } = minimal;
    void etat_administratif;
    expect(parseCompany(rest).status).toEqual({ type: "unknown" });
  });

  test("emits the annuaire-entreprises URL as registryUrl", () => {
    expect(parseCompany(minimal).registryUrl).toBe(
      "https://annuaire-entreprises.data.gouv.fr/entreprise/780129987",
    );
  });

  test("surfaces matchedEstablishment when matchedSiret is supplied", () => {
    // SIRET-mode lookup: the dispatch path passes the queried SIRET
    // so the parser can pull the right etablissement out of the
    // `matching_etablissements` array.
    const company = parseCompany(
      {
        ...minimal,
        siege: { siret: "78012998704037", est_siege: true },
        matching_etablissements: [
          { siret: "78012998700019", est_siege: false, adresse: "BRANCH" },
        ],
      },
      "78012998700019",
    );
    expect(company.matchedEstablishment?.siret).toBe("78012998700019");
    expect(company.matchedEstablishment?.isHeadOffice).toBe(false);
    expect(company.headOffice?.siret).toBe("78012998704037");
  });

  test("leaves matchedEstablishment null when no matchedSiret is supplied", () => {
    const company = parseCompany({
      ...minimal,
      siege: { siret: "78012998704037", est_siege: true },
      matching_etablissements: [{ siret: "78012998700019", est_siege: false }],
    });
    expect(company.matchedEstablishment).toBeNull();
  });

  test("filters out directors with no usable name", () => {
    const company = parseCompany({
      ...minimal,
      dirigeants: [
        {
          type_dirigeant: "personne physique",
          nom: "DOE",
          prenoms: "JANE",
          qualite: "Président",
        },
        // Anonymous / minimal row — should be skipped, not surface as
        // an empty-name director.
        {
          type_dirigeant: "personne physique",
          nom: null,
          prenoms: null,
        },
        // Organisation director.
        {
          type_dirigeant: "personne morale",
          siren: "775726417",
          denomination: "KPMG S.A",
          qualite: "Commissaire aux comptes titulaire",
        },
      ],
    });
    expect(company.directors).toHaveLength(2);
    expect(company.directors.at(0)).toMatchObject({
      type: "person",
      fullName: "JANE DOE",
      role: "Président",
    });
    expect(company.directors.at(1)).toMatchObject({
      type: "organisation",
      siren: "775726417",
      name: "KPMG S.A",
    });
  });
});

describe("parseSearchEntry", () => {
  test("surfaces siege.adresse as the search-row address", () => {
    const entry = parseSearchEntry({
      siren: "780129987",
      nom_complet: "RENAULT SAS",
      etat_administratif: "A",
      siege: {
        siret: "78012998704037",
        adresse: "122 AVENUE DU GENERAL LECLERC 92100 BOULOGNE-BILLANCOURT",
      },
    });
    expect(entry.siren).toBe("780129987");
    expect(entry.name).toBe("RENAULT SAS");
    expect(entry.address).toBe(
      "122 AVENUE DU GENERAL LECLERC 92100 BOULOGNE-BILLANCOURT",
    );
  });

  test("returns null address when siege is missing", () => {
    const entry = parseSearchEntry({
      siren: "780129987",
      nom_complet: "RENAULT SAS",
    });
    expect(entry.address).toBeNull();
  });
});
