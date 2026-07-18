import { describe, expect, test } from "bun:test";

import { parseEstablishment, parseSearchEntry } from "./parse.js";
import type { DenueRawEstablishment } from "./types.js";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const readFixture = async (name: string): Promise<DenueRawEstablishment[]> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are committed JSON payloads shaped like DENUE search
  // responses.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as DenueRawEstablishment[];
};

const raw: DenueRawEstablishment = {
  CLEE: "09015721110000111001000000U1",
  Id: "6281106",
  Nombre: "HOTEL MARRIOTT REFORMA",
  Razon_social: "HOTELERA REFORMA SA DE CV",
  Clase_actividad: "Hoteles con otros servicios integrados",
  Estrato: "251 y mas personas",
  Tipo_vialidad: "AVENIDA",
  Calle: "PASEO DE LA REFORMA",
  Num_Exterior: "276",
  Num_Interior: "",
  Colonia: "JUAREZ",
  CP: "06600",
  Ubicacion: "CUAUHTEMOC, CUAUHTEMOC, CIUDAD DE MEXICO",
  Telefono: "5550000000",
  Correo_e: "",
  Sitio_internet: "www.marriott.com",
  Tipo: "Fijo",
  Longitud: "-99.162222",
  Latitud: "19.428611",
};

describe("parseEstablishment", () => {
  test("maps DENUE Spanish fields into the domain shape", () => {
    const establishment = parseEstablishment(raw);
    expect(establishment.id).toBe("6281106");
    expect(establishment.clee).toBe("09015721110000111001000000U1");
    expect(establishment.name).toBe("HOTEL MARRIOTT REFORMA");
    expect(establishment.legalName).toBe("HOTELERA REFORMA SA DE CV");
    expect(establishment.address).toEqual({
      line1: "AVENIDA PASEO DE LA REFORMA 276",
      line2: "JUAREZ",
      postalCode: "06600",
      locality: "CUAUHTEMOC",
      municipality: "CUAUHTEMOC",
      state: "CIUDAD DE MEXICO",
      country: "MX",
      textAddress:
        "AVENIDA PASEO DE LA REFORMA 276, JUAREZ, CP 06600, CUAUHTEMOC, CUAUHTEMOC, CIUDAD DE MEXICO",
    });
    expect(establishment.coordinates).toEqual({
      latitude: 19.428611,
      longitude: -99.162222,
    });
  });

  test("tolerates sparse records", () => {
    const establishment = parseEstablishment({
      Id: "34185",
      Nombre: "",
      Latitud: "not-a-number",
      Longitud: "",
    });
    expect(establishment.name).toBe("34185");
    expect(establishment.address).toBeNull();
    expect(establishment.coordinates).toEqual({
      latitude: null,
      longitude: null,
    });
  });

  test("does not create an empty address from a postal-code sentinel", () => {
    const establishment = parseEstablishment({
      Id: "34185",
      Nombre: "MARRIOTT GUADALAJARA",
      CP: "0",
    });

    expect(establishment.address).toBeNull();
  });

  test("treats a '0' exterior/interior/local number as absent", () => {
    // DENUE uses "0" as an absent-value sentinel for Num_Exterior,
    // Num_Interior, and NumLocal, the same way it does for the postal
    // code (see __fixtures__/search-marriott.json, where the MARRIOTT
    // GUADALAJARA record has Num_Interior: "0" for an establishment with
    // no interior unit).
    const establishment = parseEstablishment({
      Id: "34185",
      Nombre: "TIENDA CENTRO",
      Tipo_vialidad: "CALLE",
      Calle: "HIDALGO",
      Num_Exterior: "0",
      Num_Interior: "0",
      NumLocal: "0",
    });

    expect(establishment.address?.line1).toBe("CALLE HIDALGO");
    expect(establishment.address?.line2).toBeNull();
    expect(establishment.unitNumber).toBeNull();
  });

  test("preserves a literal '0' in non-sentinel text fields", () => {
    // The zero-sentinel handling is scoped to the four numeric address
    // atoms; every other field keeps plain trimToNull semantics, where a
    // literal "0" is a legitimate value.
    const establishment = parseEstablishment({
      Id: "34185",
      Nombre: "0",
      Razon_social: "0",
      Estrato: "0",
    });

    expect(establishment.name).toBe("0");
    expect(establishment.legalName).toBe("0");
    expect(establishment.employeeStratum).toBe("0");
  });

  test("parses two-part location as municipality and state", () => {
    const establishment = parseEstablishment({
      Id: "34185",
      Nombre: "MARRIOTT GUADALAJARA",
      Ubicacion: "ZAPOPAN, JALISCO",
    });

    expect(establishment.address).toEqual({
      line1: null,
      line2: null,
      postalCode: null,
      locality: null,
      municipality: "ZAPOPAN",
      state: "JALISCO",
      country: "MX",
      textAddress: "ZAPOPAN, JALISCO",
    });
  });

  test("preserves comma-containing locality prefixes", () => {
    const establishment = parseEstablishment({
      Id: "34185",
      Nombre: "MARRIOTT GUADALAJARA",
      Ubicacion: "COLONIA A, LOCALIDAD B, ZAPOPAN, JALISCO",
    });

    expect(establishment.address?.locality).toBe("COLONIA A, LOCALIDAD B");
    expect(establishment.address?.municipality).toBe("ZAPOPAN");
    expect(establishment.address?.state).toBe("JALISCO");
  });
});

describe("parseSearchEntry", () => {
  test("keeps search rows thin and token-free", () => {
    const result = parseSearchEntry(raw);
    expect(result).toEqual({
      id: "6281106",
      clee: "09015721110000111001000000U1",
      name: "HOTEL MARRIOTT REFORMA",
      legalName: "HOTELERA REFORMA SA DE CV",
      activityClass: "Hoteles con otros servicios integrados",
      employeeStratum: "251 y mas personas",
      unitType: "Fijo",
      address:
        "AVENIDA PASEO DE LA REFORMA 276, JUAREZ, CP 06600, CUAUHTEMOC, CUAUHTEMOC, CIUDAD DE MEXICO",
      coordinates: {
        latitude: 19.428611,
        longitude: -99.162222,
      },
      registryUrl:
        "https://www.inegi.org.mx/app/mapa/denue/default.aspx?idee=6281106",
    });
  });
});

describe("zero-sentinel fixture guard", () => {
  test("does not leak a zero-sentinel interior number from real DENUE data", async () => {
    // CLASS GUARD: search-marriott.json's MARRIOTT GUADALAJARA record has
    // Num_Interior: "0" for an establishment with no interior unit. This
    // asserts against the fixture directly (not a synthetic example) so a
    // future tolerance regression on the sentinel fields is caught by real
    // upstream data.
    const [, guadalajara] = await readFixture("search-marriott.json");
    if (!guadalajara) {
      throw new Error("expected the Guadalajara fixture record");
    }
    expect(guadalajara.Num_Interior).toBe("0");

    const establishment = parseEstablishment(guadalajara);
    const searchEntry = parseSearchEntry(guadalajara);

    expect(establishment.address?.line2).not.toContain("Int. 0");
    expect(establishment.address?.textAddress).not.toContain("Int. 0");
    expect(searchEntry.address).not.toContain("Int. 0");
  });
});
