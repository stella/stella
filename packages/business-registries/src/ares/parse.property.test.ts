import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  expectNullableString,
  expectRegistryOutcome,
  expectRegistryResponses,
  expectRegistryResponse,
  forEachRegistryMutation,
  registryExtras,
  registryString,
} from "../shared/property-test-helpers.test.js";
import { lookupByIco, searchByName } from "./client.js";
import {
  enrichWithVr,
  parseAddress,
  parseResRecord,
  parseSearchEntry,
} from "./parse.js";

const address = fc.record(
  {
    nazevUlice: registryString,
    cisloOrientacniPismeno: registryString,
    nazevCastiObce: registryString,
    nazevMestskehoObvodu: registryString,
    pscTxt: registryString,
    nazevOkresu: registryString,
    nazevObce: registryString,
    nazevStatu: registryString,
    textovaAdresa: registryString,
    cisloDomovni: fc.option(fc.double(), { nil: null }),
    cisloOrientacni: fc.option(fc.double(), { nil: null }),
    psc: fc.option(fc.double(), { nil: null }),
  },
  { requiredKeys: [] },
);
const record = fc.record(
  {
    ico: registryString,
    obchodniJmeno: registryString,
    primarniZaznam: fc.boolean(),
    sidlo: address,
    pravniForma: registryString,
    datumVzniku: registryString,
    datumZapisu: registryString,
    czNace: fc.array(registryString, { maxLength: 4 }),
  },
  { requiredKeys: ["ico", "obchodniJmeno", "primarniZaznam"] },
);

test(
  "RES and search records preserve source identifiers and optional fields",
  () => {
    fc.assert(
      fc.property(record, registryExtras, (raw, extra) => {
        const company = expectRegistryOutcome(() =>
          parseResRecord({ ...extra, ...raw }),
        );
        expect(company?.ico).toBe(raw.ico);
        expect(company?.name).toBe(raw.obchodniJmeno);
        expect(company?.dateEstablished).toBe(raw.datumVzniku ?? null);
        expect(company?.dateRegistered).toBe(raw.datumZapisu ?? null);
        expect(company?.czNace).toEqual(raw.czNace ?? []);
        const search = expectRegistryOutcome(() => parseSearchEntry(raw));
        expect(search?.name).toBe(raw.obchodniJmeno);
        expect(search?.address).toBe(raw.sidlo?.textovaAdresa ?? null);
        if (raw.sidlo !== undefined) {
          const rawAddress = raw.sidlo;
          const parsed = expectRegistryOutcome(() => parseAddress(rawAddress));
          expectNullableString(parsed?.houseNumber);
          expectNullableString(parsed?.postalCode);
        }
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "response boundaries return typed entities or registry failures for nested mutations",
  async () => {
    await fc.assert(
      fc.asyncProperty(record, registryString, async (raw, text) => {
        const base = {
          icoId: "00006947",
          zaznamy: [{ ...raw, primarniZaznam: true }],
        };
        const vr = {
          icoId: "00006947",
          stavSubjektu: text,
          zaznamy: [
            {
              primarniZaznam: true,
              obchodniJmeno: [{ hodnota: text }],
              adresy: [{ adresa: raw.sidlo ?? {} }],
              spisovaZnacka: [{ soud: text, oddil: text, vlozka: text }],
              zakladniKapital: [{ vklad: { hodnota: "1", typObnos: text } }],
              datumVzniku: [{ hodnota: text }],
              datumZapisu: text,
              statutarniOrgany: [
                {
                  nazevOrganu: text,
                  clenoveOrganu: [
                    {
                      fyzickaOsoba: {
                        jmeno: text,
                        prijmeni: text,
                        titulPredJmenem: text,
                        titulZaJmenem: text,
                      },
                      pravnickaOsoba: {
                        obchodniJmeno: text,
                        adresa: raw.sidlo ?? {},
                      },
                      osoba: { nazevAngazma: text },
                      nazevAngazma: text,
                      clenstvi: {
                        funkce: { nazev: text },
                        clenstvi: { vznikClenstvi: text },
                      },
                    },
                  ],
                  zpusobJednani: [{ hodnota: text }],
                },
              ],
            },
          ],
        };
        const primary = vr.zaznamy.at(0);
        expect(primary).toBeDefined();
        if (primary) {
          Object.assign(primary, { ostatniOrgany: primary.statutarniOrgany });
        }
        const original = await expectRegistryResponses(
          (url) => (url.includes("ekonomicke-subjekty-vr") ? vr : base),
          () => lookupByIco("00006947"),
        );
        expect(original?.vrEnrichmentStatus).toBe("complete");
        for (const mutateVr of [false, true]) {
          await forEachRegistryMutation(
            mutateVr ? vr : base,
            async (changed) => {
              const company = await expectRegistryResponses(
                (url) => {
                  if (url.includes("ekonomicke-subjekty-vr")) {
                    return mutateVr ? changed : vr;
                  }
                  return mutateVr ? base : changed;
                },
                () => lookupByIco("00006947"),
              );
              if (!company) {
                return;
              }
              expect(typeof company.ico).toBe("string");
              expect(typeof company.name).toBe("string");
              expectNullableString(company.legalForm);
              expectNullableString(company.dateEstablished);
              expectNullableString(company.status);
              expectNullableString(company.shareCapital);
              if (company.address) {
                for (const value of Object.values(company.address)) {
                  expectNullableString(value);
                }
              }
              for (const body of company.statutoryBodies) {
                expect(typeof body.organName).toBe("string");
                for (const member of body.members) {
                  expect(typeof member.name).toBe("string");
                  expectNullableString(member.role);
                  expectNullableString(member.since);
                }
              }
            },
          );
        }
      }),
      propertyConfig({ numRuns: 2, seed: propertySeed() }),
    );
  },
  propertyTestTimeout(30_000),
);

test(
  "VR enrichment retains unknown currencies and Unicode source values",
  () => {
    fc.assert(
      fc.property(
        record,
        registryString,
        registryString,
        (raw, currency, name) => {
          const company = parseResRecord(raw);
          const enriched = expectRegistryOutcome(() =>
            enrichWithVr(company, {
              icoId: raw.ico,
              zaznamy: [
                {
                  primarniZaznam: true,
                  obchodniJmeno: [{ hodnota: name }],
                  zakladniKapital: [
                    { vklad: { hodnota: "1", typObnos: currency } },
                  ],
                  statutarniOrgany: [
                    {
                      nazevOrganu: name,
                      clenoveOrganu: [
                        { fyzickaOsoba: { jmeno: name, prijmeni: "surname" } },
                      ],
                      zpusobJednani: [{ hodnota: name }],
                    },
                  ],
                },
              ],
            }),
          );
          expect(enriched?.name).toBe(name);
          const known = new Map([
            ["KORUNY", "Kč"],
            ["EURA", "EUR"],
            ["EUR", "EUR"],
          ]);
          expect(enriched?.shareCapital).toBe(
            `1,- ${known.get(currency) ?? currency}`.trim(),
          );
          expect(
            enriched?.statutoryBodies.every(
              (body) => typeof body.organName === "string",
            ),
          ).toBe(true);
          expectNullableString(enriched?.actingClause);
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "search boundaries retain typed projections for every response field mutation",
  async () => {
    await fc.assert(
      fc.asyncProperty(record, async (raw) => {
        const searchEntry = { ...raw, ico: raw.ico || "00006947" };
        const payload = { pocetCelkem: 1, ekonomickeSubjekty: [searchEntry] };
        const operation = () => searchByName("company");
        expect(await expectRegistryResponse(payload, operation)).toMatchObject([
          { ico: searchEntry.ico, name: searchEntry.obchodniJmeno },
        ]);
        await forEachRegistryMutation(payload, async (changed) => {
          const result = await expectRegistryResponse(changed, operation);
          if (!result) {
            return;
          }
          for (const entry of result) {
            expect(typeof entry.ico).toBe("string");
            expect(typeof entry.name).toBe("string");
            expectNullableString(entry.address);
          }
        });
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 5 }),
    );
  },
  propertyTestTimeout(10_000),
);
