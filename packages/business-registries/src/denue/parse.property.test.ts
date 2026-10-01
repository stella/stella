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
  registryString,
} from "../shared/property-test-helpers.test.js";
import { lookupByEstablishmentId } from "./client.js";
import { parseEstablishment, parseSearchEntry } from "./parse.js";
import type { DenueEstablishment, DenueRawEstablishment } from "./types.js";

const establishment = fc
  .record(
    {
      Id: registryString,
      Nombre: registryString,
      CLEE: registryString,
      Razon_social: registryString,
      Clase_actividad: registryString,
      Estrato: registryString,
      Tipo_vialidad: registryString,
      Calle: registryString,
      Num_Exterior: registryString,
      Num_Interior: registryString,
      Colonia: registryString,
      CP: registryString,
      Ubicacion: registryString,
      Telefono: registryString,
      Correo_e: registryString,
      Sitio_internet: registryString,
      Tipo: registryString,
      Longitud: registryString,
      Latitud: registryString,
      CentroComercial: registryString,
      TipoCentroComercial: registryString,
      NumLocal: registryString,
    },
    { requiredKeys: ["Id", "Nombre"] },
  )
  .map((raw) => raw satisfies DenueRawEstablishment);

test("establishments preserve identities and finite coordinates across projections", () => {
  fc.assert(
    fc.property(establishment, (raw) => {
      const output = expectRegistryOutcome(() => parseEstablishment(raw));
      if (output === undefined) {
        return;
      }
      expect(output.id).toBe(raw.Id);
      expect(output.name).toBe(raw.Nombre.trim() || raw.Id);
      for (const coordinate of Object.values(output.coordinates)) {
        expect(coordinate === null || Number.isFinite(coordinate)).toBe(true);
      }
      for (const value of [
        output.clee,
        output.legalName,
        output.phone,
        output.email,
        output.website,
        output.unitNumber,
      ]) {
        expectNullableString(value);
      }
      expect(output.unitNumber).not.toBe("0");
      if (output.address) {
        expect(output.address.country).toBe("MX");
        expect(output.address.postalCode).not.toBe("0");
        for (const value of Object.values(output.address)) {
          expectNullableString(value);
        }
        expect(output.address.textAddress?.length).toBeGreaterThan(0);
      }
      const search = parseSearchEntry(raw);
      expect(search.id).toBe(output.id);
      expect(search.name).toBe(output.name);
      expect(search.coordinates).toEqual(output.coordinates);
      expect(search.address).toBe(output.address?.textAddress ?? null);
      expect(search.registryUrl).toBe(output.registryUrl);
    }),
    propertyConfig({ seed: propertySeed() }),
  );
});

const expectTypedOutput = (output: DenueEstablishment) => {
  expect(typeof output.id).toBe("string");
  expect(typeof output.name).toBe("string");
  for (const value of [
    output.clee,
    output.legalName,
    output.phone,
    output.email,
    output.website,
    output.unitNumber,
  ]) {
    expectNullableString(value);
  }
  for (const value of Object.values(output.coordinates)) {
    expect(value === null || Number.isFinite(value)).toBe(true);
  }
  if (output.address) {
    expect(output.address.country).toBe("MX");
    for (const value of Object.values(output.address)) {
      expectNullableString(value);
    }
  }
};

test("establishment response mutations retain typed addresses or registry failures", async () => {
  await fc.assert(
    fc.asyncProperty(
      establishment,
      fc.nat(),
      registryMutation,
      async (raw, selected, mutation) => {
        const original = [{ ...raw, Id: "6281106", Nombre: "Hotel" }];
        const operation = async () =>
          lookupByEstablishmentId("6281106", { token: "property-token" });
        expect(await expectRegistryResponse(original, operation)).toMatchObject(
          { id: "6281106", name: "Hotel" },
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
  const original = [
    {
      Id: "6281106",
      Nombre: "Hotel",
      CLEE: "clee",
      Razon_social: "Hotel SA",
      Clase_actividad: "Hotel",
      Estrato: "10",
      Tipo_vialidad: "Calle",
      Calle: "Principal",
      Num_Exterior: "5",
      Num_Interior: "2",
      Colonia: "Centro",
      CP: "01234",
      Ubicacion: "Localidad, Municipio, Estado",
      Telefono: "123",
      Correo_e: "hotel@example.test",
      Sitio_internet: "https://example.test",
      Tipo: "Fijo",
      Longitud: "-99.1",
      Latitud: "19.4",
      CentroComercial: "Centro",
      TipoCentroComercial: "Comercial",
      NumLocal: "3",
    } satisfies DenueRawEstablishment,
  ];
  const operation = async () =>
    lookupByEstablishmentId("6281106", { token: "property-token" });
  expect(await expectRegistryResponse(original, operation)).toMatchObject({
    id: "6281106",
    name: "Hotel",
  });
  await forEachRegistryMutation(original, async (payload) => {
    const output = await expectRegistryResponse(payload, operation);
    if (output) {
      expectTypedOutput(output);
    }
  });
});
