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
import { lookupByOrgnr, searchByName } from "./client.js";
import { parseAddress, parseEnhet, parseSearchEntry } from "./parse.js";
import type { BrregRawAddress, BrregRawEnhet } from "./types.js";

const address = fc
  .record(
    {
      land: registryString,
      postnummer: registryString,
      poststed: registryString,
      adresse: fc.array(registryString, { maxLength: 4 }),
      kommune: registryString,
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies BrregRawAddress);
const entity = fc
  .record(
    {
      organisasjonsnummer: registryString,
      navn: registryString,
      forretningsadresse: address,
      beliggenhetsadresse: address,
      postadresse: address,
      organisasjonsform: fc.record(
        { kode: registryString, beskrivelse: registryString },
        { requiredKeys: [] },
      ),
      naeringskode1: fc.record(
        { kode: registryString, beskrivelse: registryString },
        { requiredKeys: [] },
      ),
      registreringsdatoEnhetsregisteret: registryString,
      stiftelsesdato: registryString,
      underAvviklingDato: registryString,
      tvangsopplostPgaManglendeRegnskapDato: registryString,
      tvangsopplostPgaManglendeRevisorDato: registryString,
      tvangsopplostPgaMangelfulltStyreDato: registryString,
      tvangsopplostPgaManglendeDagligLederDato: registryString,
      tvangsavvikletPgaManglendeSlettingDato: registryString,
      slettedato: registryString,
      nedleggelsesdato: registryString,
      konkurs: fc.boolean(),
      konkursdato: registryString,
      underAvvikling: fc.boolean(),
      underTvangsavviklingEllerTvangsopplosning: fc.boolean(),
      registrertIMvaregisteret: fc.boolean(),
      antallAnsatte: fc.integer(),
    },
    { requiredKeys: ["organisasjonsnummer", "navn"] },
  )
  .map((raw) => raw satisfies BrregRawEnhet);

test(
  "entity and search preserve identifiers, names and physical address precedence",
  () => {
    fc.assert(
      fc.property(
        entity,
        registryExtras,
        fc.constantFrom("enhet", "underenhet"),
        (raw, extras, kind) => {
          const enriched = { extraFields: extras, ...raw };
          const parsed = expectRegistryOutcome(() =>
            parseEnhet(enriched, kind),
          );
          const search = expectRegistryOutcome(() =>
            parseSearchEntry(enriched),
          );
          if (!parsed || !search) {
            return;
          }
          expect(parsed.orgnr).toBe(raw.organisasjonsnummer);
          expect(parsed.name).toBe(raw.navn);
          expect(search.orgnr).toBe(parsed.orgnr);
          expect(search.name).toBe(parsed.name);
          expect(search.address).toBe(
            parsed.businessAddress?.textAddress ?? null,
          );
          const physical = raw.forretningsadresse ?? raw.beliggenhetsadresse;
          expect(parsed.businessAddress).toEqual(
            physical ? parseAddress(physical) : null,
          );
          expect(parsed.vatRegistered).toBe(
            raw.registrertIMvaregisteret === true,
          );
          expect(
            parsed.registryUrl.endsWith(
              encodeURIComponent(raw.organisasjonsnummer.toWellFormed()),
            ),
          ).toBe(true);
          const removed = raw.slettedato ?? raw.nedleggelsesdato;
          if (removed) {
            expect(parsed.status).toEqual({
              type: "deleted",
              deletedAt: removed,
            });
          }
          for (const code of parsed.industryCodes) {
            expect(code.code.length).toBeGreaterThan(0);
          }
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "address atoms remain available even with sparse address lines",
  () => {
    fc.assert(
      fc.property(address, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseAddress(enriched));
        if (!parsed) {
          return;
        }
        expect(parsed.street).toBe(raw.adresse?.find(Boolean) ?? null);
        expect(parsed.postalCode).toBe(raw.postnummer ?? null);
        expect(parsed.city).toBe(raw.poststed ?? null);
        expect(parsed.country).toBe(raw.land ?? null);
        expectNullableString(parsed.textAddress);
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "lookup and search response fields accept domain values or registry errors",
  async () => {
    await fc.assert(
      fc.asyncProperty(entity, async (raw) => {
        const baseline = await expectRegistryResponse(raw, async () =>
          lookupByOrgnr("923609016", {
            observer: "unobserved",
            includeSubEntities: false,
          }),
        );
        expect(baseline?.orgnr).toBe(raw.organisasjonsnummer);
        expect(baseline?.name).toBe(raw.navn);
        await forEachRegistryMutation(raw, async (mutated) => {
          const parsed = await expectRegistryResponse(mutated, async () =>
            lookupByOrgnr("923609016", {
              observer: "unobserved",
              includeSubEntities: false,
            }),
          );
          if (!parsed) {
            return;
          }
          expect(parsed.orgnr).toBe(raw.organisasjonsnummer);
          expect(parsed.name).toBe(raw.navn);
          for (const value of [
            parsed.legalForm,
            parsed.legalFormCode,
            parsed.registeredAt,
            parsed.establishedAt,
          ]) {
            expectNullableString(value);
          }
          expect(
            parsed.numberOfEmployees === null ||
              typeof parsed.numberOfEmployees === "number",
          ).toBe(true);
          expect(typeof parsed.vatRegistered).toBe("boolean");
          if (parsed.status.type === "deleted") {
            expect(typeof parsed.status.deletedAt).toBe("string");
          } else if (parsed.status.type !== "active") {
            expectNullableString(parsed.status.openedAt);
          }
          for (const code of parsed.industryCodes) {
            expect(typeof code.code).toBe("string");
            expectNullableString(code.description);
          }
          for (const parsedAddress of [
            parsed.businessAddress,
            parsed.postalAddress,
          ]) {
            if (parsedAddress) {
              for (const value of Object.values(parsedAddress)) {
                expectNullableString(value);
              }
            }
          }
        });
        await forEachRegistryMutation(
          { _embedded: { enheter: [raw] } },
          async (mutated) => {
            const results = await expectRegistryResponse(mutated, async () =>
              searchByName("registry", { observer: "unobserved" }),
            );
            if (results) {
              for (const result of results) {
                expect(typeof result.orgnr).toBe("string");
                expect(typeof result.name).toBe("string");
                expectNullableString(result.address);
              }
            }
          },
        );
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 5 }),
    );
  },
  propertyTestTimeout(10_000),
);
