import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  expectNullableString,
  expectRegistryOutcome,
  expectRegistryResponse,
  forEachRegistryMutation,
  mutatedRegistryPayload,
  registryMutation,
  nullableRegistryString,
  registryString,
} from "../shared/property-test-helpers.test.js";
import { lookupBySiren, lookupBySiret } from "./client.js";
import {
  parseAddress,
  parseCompany,
  parseEstablishment,
  parseSearchEntry,
} from "./parse.js";
import type {
  RechercheEntreprisesCompany,
  RechercheEntreprisesRawEtablissement,
  RechercheEntreprisesRawDirigeant,
  RechercheEntreprisesRawUniteLegale,
} from "./types.js";

const establishment = fc
  .record({
    siret: registryString,
    etat_administratif: fc.oneof(
      nullableRegistryString,
      fc.constantFrom("A", "F"),
    ),
    est_siege: fc.option(fc.boolean(), { nil: null }),
    adresse: nullableRegistryString,
    numero_voie: nullableRegistryString,
    type_voie: nullableRegistryString,
    libelle_voie: nullableRegistryString,
    code_postal: nullableRegistryString,
    libelle_commune: nullableRegistryString,
    libelle_commune_etranger: nullableRegistryString,
    libelle_pays_etranger: nullableRegistryString,
    code_pays_etranger: nullableRegistryString,
    activite_principale: nullableRegistryString,
    date_creation: nullableRegistryString,
    date_fermeture: nullableRegistryString,
  })
  .map((raw) => raw satisfies RechercheEntreprisesRawEtablissement);
const director = fc.oneof(
  fc
    .record({
      nom: nullableRegistryString,
      prenoms: nullableRegistryString,
      qualite: nullableRegistryString,
      annee_de_naissance: nullableRegistryString,
      type_dirigeant: fc.constant("personne physique"),
    })
    .map((raw) => raw satisfies RechercheEntreprisesRawDirigeant),
  fc
    .record({
      siren: nullableRegistryString,
      denomination: nullableRegistryString,
      qualite: nullableRegistryString,
      type_dirigeant: fc.constant("personne morale"),
    })
    .map((raw) => raw satisfies RechercheEntreprisesRawDirigeant),
);
const company = fc
  .record({
    siren: registryString,
    nom_complet: registryString,
    sigle: nullableRegistryString,
    nature_juridique: nullableRegistryString,
    etat_administratif: fc.oneof(
      nullableRegistryString,
      fc.constantFrom("A", "C"),
    ),
    date_creation: nullableRegistryString,
    date_fermeture: nullableRegistryString,
    siege: fc.option(establishment, { nil: null }),
    matching_etablissements: fc.array(establishment, { maxLength: 5 }),
    dirigeants: fc.array(director, { maxLength: 5 }),
  })
  .map((raw) => raw satisfies RechercheEntreprisesRawUniteLegale);

test("legal entities retain nested establishment identities and named directors", () => {
  fc.assert(
    fc.property(company, registryString, (raw, queriedSiret) => {
      const matchedSiret =
        raw.matching_etablissements.at(0)?.siret || queriedSiret;
      const output = expectRegistryOutcome(() =>
        parseCompany(raw, matchedSiret),
      );
      if (output === undefined) {
        return;
      }
      expect(output.siren).toBe(raw.siren);
      expect(output.name).toBe(raw.nom_complet);
      expect(["active", "ceased", "unknown"]).toContain(output.status.type);
      for (const value of [
        output.legalFormCode,
        output.shortName,
        output.registeredAt,
        output.ceasedAt,
      ]) {
        expectNullableString(value);
      }
      if (output.status.type === "ceased") {
        expectNullableString(output.status.ceasedAt);
      }
      expect(output.headOffice).toEqual(
        raw.siege ? parseEstablishment(raw.siege) : null,
      );
      const matched = raw.matching_etablissements.find(
        (entry) => entry.siret === matchedSiret,
      );
      expect(output.matchedEstablishment).toEqual(
        matched ? parseEstablishment(matched) : null,
      );
      for (const nested of [output.headOffice, output.matchedEstablishment]) {
        if (!nested) {
          continue;
        }
        expect(typeof nested.siret).toBe("string");
        expect(typeof nested.isHeadOffice).toBe("boolean");
        expect(["open", "closed", "unknown"]).toContain(nested.status.type);
        expectNullableString(nested.createdAt);
        expectNullableString(nested.closedAt);
        if (nested.address) {
          for (const value of Object.values(nested.address)) {
            expectNullableString(value);
          }
        }
      }
      expect(output.directors.length).toBeLessThanOrEqual(
        raw.dirigeants.length,
      );
      for (const entry of output.directors) {
        expectNullableString(entry.role);
        if (entry.type === "person") {
          expect(entry.fullName.trim().length).toBeGreaterThan(0);
          expectNullableString(entry.birthYear);
        } else {
          expect(entry.name.trim().length).toBeGreaterThan(0);
          expectNullableString(entry.siren);
        }
      }
      expect(parseSearchEntry(raw)).toEqual({
        siren: output.siren,
        name: output.name,
        address: raw.siege
          ? (parseAddress(raw.siege)?.textAddress ?? null)
          : null,
      });
    }),
    propertyConfig({ seed: propertySeed() }),
  );
});

const expectTypedOutput = (output: RechercheEntreprisesCompany) => {
  expect(typeof output.siren).toBe("string");
  expect(typeof output.name).toBe("string");
  expect(["active", "ceased", "unknown"]).toContain(output.status.type);
  for (const value of [
    output.legalFormCode,
    output.shortName,
    output.registeredAt,
    output.ceasedAt,
  ]) {
    expectNullableString(value);
  }
  for (const nested of [output.headOffice, output.matchedEstablishment]) {
    if (!nested) {
      continue;
    }
    expect(typeof nested.siret).toBe("string");
    expect(typeof nested.isHeadOffice).toBe("boolean");
    expect(["open", "closed", "unknown"]).toContain(nested.status.type);
    expectNullableString(nested.activityCode);
    expectNullableString(nested.createdAt);
    expectNullableString(nested.closedAt);
    if (nested.address) {
      for (const value of Object.values(nested.address)) {
        expectNullableString(value);
      }
    }
  }
  for (const parsedDirector of output.directors) {
    expect(["person", "organisation"]).toContain(parsedDirector.type);
    expectNullableString(parsedDirector.role);
    if (parsedDirector.type === "person") {
      expect(typeof parsedDirector.fullName).toBe("string");
      expect(parsedDirector.fullName.length).toBeGreaterThan(0);
      expectNullableString(parsedDirector.birthYear);
    } else {
      expect(typeof parsedDirector.name).toBe("string");
      expect(parsedDirector.name.length).toBeGreaterThan(0);
      expectNullableString(parsedDirector.siren);
    }
  }
};

test("legal entity response mutations retain typed nested data or registry failures", async () => {
  await fc.assert(
    fc.asyncProperty(
      company,
      fc.nat(),
      registryMutation,
      async (raw, selected, mutation) => {
        const original = {
          results: [{ ...raw, siren: "780129987" }],
          total_results: 1,
          page: 1,
          per_page: 1,
          total_pages: 1,
        };
        const operation = async () =>
          lookupBySiren("780129987", { observer: "unobserved" });
        expect(await expectRegistryResponse(original, operation)).toMatchObject(
          { siren: "780129987", name: raw.nom_complet },
        );
        const payload = mutatedRegistryPayload({
          payload: original,
          selected,
          mutation,
        });
        const output = await expectRegistryResponse(payload, operation);
        if (!output) {
          return;
        }
        expectTypedOutput(output);
      },
    ),
    propertyConfig({ seed: propertySeed(), numRuns: 20 }),
  );
});

test("every consumed response field supports missing, null and wrong-type mutations", async () => {
  const office = {
    siret: "78012998704037",
    etat_administratif: "F",
    est_siege: true,
    adresse: "1 rue Principale",
    numero_voie: "1",
    type_voie: "rue",
    libelle_voie: "Principale",
    code_postal: "75001",
    libelle_commune: "Paris",
    libelle_commune_etranger: "Commune étrangère",
    libelle_pays_etranger: "Pays",
    code_pays_etranger: "FR",
    activite_principale: "29.10Z",
    date_creation: "2000-01-01",
    date_fermeture: "2026-01-01",
  } satisfies RechercheEntreprisesRawEtablissement;
  const original = {
    results: [
      {
        siren: "780129987",
        nom_complet: "Société",
        nature_juridique: "5710",
        sigle: "S",
        etat_administratif: "C",
        date_creation: "2000-01-01",
        date_fermeture: "2026-01-01",
        siege: { ...office },
        matching_etablissements: [{ ...office }],
        dirigeants: [
          {
            type_dirigeant: "personne physique",
            nom: "Nom",
            prenoms: "Prénom",
            qualite: "Président",
            annee_de_naissance: "1970",
          },
          {
            type_dirigeant: "personne morale",
            siren: "780129987",
            denomination: "Société",
            qualite: "Associé",
          },
        ],
      } satisfies RechercheEntreprisesRawUniteLegale,
    ],
    total_results: 1,
    page: 1,
    per_page: 1,
    total_pages: 1,
  };
  const operation = async () =>
    lookupBySiret("78012998704037", { observer: "unobserved" });
  expect(await expectRegistryResponse(original, operation)).toMatchObject({
    siren: "780129987",
    name: "Société",
  });
  await forEachRegistryMutation(original, async (payload) => {
    const output = await expectRegistryResponse(payload, operation);
    if (output) {
      expectTypedOutput(output);
    }
  });
});
