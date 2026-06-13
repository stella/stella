import { describe, expect, test } from "bun:test";

import { parseEstablishment, parseSearchEntry } from "./parse.js";
import type { DenueRawEstablishment } from "./types.js";

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
      latitude: 19.428_611,
      longitude: -99.162_222,
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
        latitude: 19.428_611,
        longitude: -99.162_222,
      },
      registryUrl:
        "https://www.inegi.org.mx/app/mapa/denue/default.aspx?idee=6281106",
    });
  });
});
