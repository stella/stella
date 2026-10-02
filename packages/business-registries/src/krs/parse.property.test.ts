import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  expectRegistryResponse,
  registryString,
  registryExtras,
  forEachRegistryMutation,
  expectRegistryOutcome,
  expectNullableString,
} from "../shared/property-test-helpers.test.js";
import { lookupByKrsNumber } from "./client.js";
import { parseAddress, parseEntity } from "./parse.js";
import { normalizeRegon } from "./regon.js";
import type { KrsRawAdres, KrsLookupResponse } from "./types.js";

const address = fc
  .record(
    {
      ulica: registryString,
      nrDomu: registryString,
      nrLokalu: registryString,
      miejscowosc: registryString,
      kodPocztowy: registryString,
      kraj: registryString,
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies KrsRawAdres);
const entity = fc
  .record(
    {
      odpis: fc.record(
        {
          naglowekA: fc.record(
            {
              rejestr: registryString,
              dataRejestracjiWKRS: registryString,
              dataOstatniegoWpisu: registryString,
            },
            { requiredKeys: [] },
          ),
          dane: fc.record(
            {
              dzial1: fc.record(
                {
                  danePodmiotu: fc.record(
                    {
                      nazwa: registryString,
                      formaPrawna: registryString,
                      identyfikatory: fc.record(
                        { nip: registryString, regon: registryString },
                        { requiredKeys: [] },
                      ),
                    },
                    { requiredKeys: [] },
                  ),
                  siedzibaIAdres: fc.record(
                    {
                      adres: address,
                      adresPocztyElektronicznej: registryString,
                      adresStronyInternetowej: registryString,
                    },
                    { requiredKeys: [] },
                  ),
                  kapital: fc.record(
                    {
                      wysokoscKapitaluZakladowego: fc.record(
                        { wartosc: registryString, waluta: registryString },
                        { requiredKeys: [] },
                      ),
                    },
                    { requiredKeys: [] },
                  ),
                },
                { requiredKeys: [] },
              ),
              dzial6: fc.record(
                {
                  wykreslenia: fc.array(fc.jsonValue(), { maxLength: 3 }),
                  postepowanieUpadlosciowe: fc.array(fc.jsonValue(), {
                    maxLength: 3,
                  }),
                },
                { requiredKeys: [] },
              ),
            },
            { requiredKeys: [] },
          ),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies KrsLookupResponse);

test(
  "sparse nested extracts preserve the requested identifier and filed values",
  () => {
    fc.assert(
      fc.property(
        entity,
        registryString,
        registryExtras,
        (raw, number, extras) => {
          const enriched = { extraFields: extras, ...raw };
          const parsed = expectRegistryOutcome(() =>
            parseEntity(enriched, number),
          );
          if (!parsed) {
            return;
          }
          const dzial1 = raw.odpis?.dane?.dzial1;
          expect(parsed.krsNumber).toBe(number);
          expect(parsed.name).toBe(
            dzial1?.danePodmiotu?.nazwa?.trim() ?? number,
          );
          expect(parsed.identifiers.nip).toBe(
            dzial1?.danePodmiotu?.identyfikatory?.nip?.trim() || null,
          );
          const regon = dzial1?.danePodmiotu?.identyfikatory?.regon?.trim();
          expect(parsed.identifiers.regon).toBe(
            regon ? normalizeRegon(regon) : null,
          );
          expect(parsed.address).toEqual(
            dzial1?.siedzibaIAdres?.adres
              ? parseAddress(dzial1.siedzibaIAdres.adres)
              : null,
          );
          expect(parsed.register).toBe(
            raw.odpis?.naglowekA?.rejestr === "RejS" ? "RejS" : "RejP",
          );
          expect(parsed.registeredAt).toBe(
            raw.odpis?.naglowekA?.dataRejestracjiWKRS?.trim() || null,
          );
          if ((raw.odpis?.dane?.dzial6?.wykreslenia?.length ?? 0) > 0) {
            expect(parsed.status.type).toBe("dissolved");
          }
          if (parsed.shareCapital) {
            expect(
              dzial1?.kapital?.wysokoscKapitaluZakladowego?.wartosc?.trim(),
            ).toBe(parsed.shareCapital.amount);
            expect(
              dzial1?.kapital?.wysokoscKapitaluZakladowego?.waluta?.trim(),
            ).toBe(parsed.shareCapital.currency);
          }
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "address parsing trims postal atoms without losing their spelling",
  () => {
    fc.assert(
      fc.property(address, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseAddress(enriched));
        if (!parsed) {
          return;
        }
        expect(parsed.city).toBe(raw.miejscowosc?.trim() || null);
        expect(parsed.postalCode).toBe(raw.kodPocztowy?.trim() || null);
        expect(parsed.country).toBe(raw.kraj?.trim() || null);
        for (const value of Object.values(parsed)) {
          expectNullableString(value);
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "lookup response mutations retain the requested number or yield registry errors",
  async () => {
    const fixture: unknown = await Bun.file(
      new URL("__fixtures__/lookup-cd-projekt.json", import.meta.url),
    ).json();
    const supplemental = {
      odpis: {
        naglowekA: {
          rejestr: "RejS",
          dataRejestracjiWKRS: "01.01.2020",
          dataOstatniegoWpisu: "01.01.2026",
        },
        dane: {
          dzial1: {
            danePodmiotu: {
              nazwa: "Company",
              formaPrawna: "Association",
              identyfikatory: { nip: "1234567890", regon: "123456789" },
            },
            siedzibaIAdres: {
              siedziba: {
                kraj: "Polska",
                wojewodztwo: "Region",
                powiat: "County",
                gmina: "Commune",
                miejscowosc: "City",
              },
              adres: {
                ulica: "Street",
                nrDomu: "1",
                nrLokalu: "2",
                miejscowosc: "City",
                kodPocztowy: "00-001",
                kraj: "Polska",
              },
              adresPocztyElektronicznej: "public@example.test",
              adresStronyInternetowej: "https://example.test",
            },
            kapital: {
              wysokoscKapitaluZakladowego: { wartosc: "1,00", waluta: "PLN" },
            },
          },
          dzial6: {
            postepowanieUpadlosciowe: [
              { opisZakonczeniaProcesuUpadlosci: { opis: "Closed" } },
            ],
            postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
              [
                {
                  otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                    { rodzajPostepowania: "LIKWIDACJA" },
                  zakonczeniePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                    { rodzajPostepowania: "Closed" },
                },
              ],
            wykreslenia: [],
          },
        },
      },
    } satisfies KrsLookupResponse;
    for (const payload of [fixture, supplemental]) {
      const baseline = await expectRegistryResponse(payload, async () =>
        lookupByKrsNumber("0000006865", {
          observer: "unobserved",
          register: "RejP",
        }),
      );
      expect(baseline?.krsNumber).toBe("0000006865");
      await forEachRegistryMutation(payload, async (mutated) => {
        const parsed = await expectRegistryResponse(mutated, async () =>
          lookupByKrsNumber("0000006865", {
            observer: "unobserved",
            register: "RejP",
          }),
        );
        if (!parsed) {
          return;
        }
        expect(parsed.krsNumber).toBe("0000006865");
        expect(typeof parsed.name).toBe("string");
        expectNullableString(parsed.email);
        expectNullableString(parsed.website);
        if (parsed.registeredSeat) {
          for (const value of Object.values(parsed.registeredSeat)) {
            expectNullableString(value);
          }
        }
        if (parsed.shareCapital) {
          for (const value of Object.values(parsed.shareCapital)) {
            expect(typeof value).toBe("string");
          }
        }
        for (const value of [
          parsed.legalForm,
          parsed.identifiers.nip,
          parsed.identifiers.regon,
          parsed.registeredAt,
          parsed.lastEntryAt,
        ]) {
          expectNullableString(value);
        }
        if (parsed.address) {
          for (const value of Object.values(parsed.address)) {
            expectNullableString(value);
          }
        }
      });
    }
  },
  propertyTestTimeout(10_000),
);
